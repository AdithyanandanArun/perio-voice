/**
 * The clinical voice intelligence pipeline.
 *
 * One recognition result enters; a chart transition, a held confirmation or a
 * recorded refusal comes out. Every stage is a separate, testable decision and
 * every stage appends to a trace, so the interface can always answer "why did
 * that value appear, or not appear?".
 *
 *   speaker → staleness → lexicon → lattice → relevance → context resolution
 *           → grammar → negation → correction → sequence guard → commit
 *
 * The ordering matters. Speech that does not belong to the clinician, or that
 * was overtaken by a change of location, is stopped before it can influence
 * anything. Relevance runs on safe vocabulary only, so the risky lexicon
 * variants cannot be what makes casual speech look clinical.
 */

import { canonicalize } from './lexicon';
import { acousticConfidence, buildLattice } from './lattice';
import { classifyRelevance, explainRelevance, type RelevanceDecision } from './relevance';
import { resolveWithContext } from './contextResolver';
import { parseIntents, type Intent, type ParseResult, type WorkflowCommand } from './grammar';
import { describeAssertion, needsPolarityConfirmation, type FindingAssertion } from './negation';
import { guardIntent } from './sequenceGuard';
import { describeCorrection, entryForSite, resolveCorrection } from './correction';
import {
  invertChanges,
  markUndone,
  redoableEntry,
  undoableEntry,
} from './journal';
import {
  advanceStation,
  isStaleObservation,
  jumpToStation,
  resumeStation,
  retreatStation,
  skipTooth,
} from './workflow';
import {
  isStationComplete,
  measurementValues,
  nextOpenPosition,
  recordAt,
  siteName,
} from './chart';
import {
  addPending,
  bumpCounter,
  commitChanges,
  findPending,
  recordEvent,
  recordParserDuration,
  removePending,
  utteranceLatency,
} from './session';
import { SITES_PER_STATION, type ChartChange, type PipelineOverrides, type ClinicalEventKind, type ClinicalSession, type MeasurementType, type StageName, type StageOutcome, type StageTrace, type UtteranceInput } from './types';

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

class Trace {
  private readonly entries: StageTrace[] = [];
  private mark = now();

  add(stage: StageName, outcome: StageOutcome, detail: string): void {
    const at = now();
    this.entries.push({ stage, outcome, detail, durationMs: round(at - this.mark) });
    this.mark = at;
  }

  snapshot(): StageTrace[] {
    return [...this.entries];
  }

  get totalMs(): number {
    return round(this.entries.reduce((sum, entry) => sum + entry.durationMs, 0));
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

interface Outcome {
  session: ClinicalSession;
  kind: ClinicalEventKind;
  message: string;
  changes: ChartChange[];
  latencyEligible: boolean;
  supersedes: number | null;
  /** Set when this outcome exists only to reverse or reinstate an entry. */
  compensates: number | null;
  stop: boolean;
}

/** Runs one final recognition result through every stage. */
export function processUtterance(
  session: ClinicalSession,
  input: UtteranceInput,
): ClinicalSession {
  const trace = new Trace();
  const started = now();
  const at = input.timing.observedAt;
  const approved = input.overrides ?? {};

  const finish = (
    next: ClinicalSession,
    kind: ClinicalEventKind,
    message: string,
    options: {
      changes?: ChartChange[];
      latencyEligible?: boolean;
      supersedes?: number | null;
      compensates?: number | null;
    } = {},
  ): ClinicalSession => {
    const committed = recordEvent(next, {
      kind,
      transcript: input.transcript,
      message,
      occurredAt: at,
      latencyMs: options.latencyEligible === true ? utteranceLatency(input) : null,
      trace: trace.snapshot(),
      changes: options.changes,
      supersedes: options.supersedes ?? null,
      compensates: options.compensates ?? undefined,
    });
    return recordParserDuration(committed, round(now() - started));
  };

  /* -------- 1. speaker attribution -------- */
  const speaker = input.speaker;
  if (speaker !== null && session.settings.requireSpeaker && !speaker.overridden && approved.speaker !== true) {
    if (speaker.decision === 'other') {
      trace.add('speaker', 'block', `attributed to another speaker (${speaker.similarity.toFixed(2)})`);
      return finish(bumpCounter(session, 'blockedSpeaker'), 'ignored', 'Speech was not attributed to the enrolled clinician, so nothing was charted.');
    }
    if (speaker.decision === 'unknown') {
      trace.add('speaker', 'confirm', `speaker not recognized (${speaker.similarity.toFixed(2)})`);
      const held = addPending(bumpCounter(session, 'blockedSpeaker'), {
        reason: 'unknown_speaker',
        transcript: input.transcript,
        message: 'Speaker was not recognized. Confirm that the clinician said this.',
        createdAt: at,
        input,
      });
      return finish(held, 'confirmation', 'Held for speaker confirmation: unrecognized voice.');
    }
  }
  trace.add('speaker', 'pass', speaker === null ? 'no attribution required' : `attributed to the clinician`);

  /* -------- 2. staleness -------- */
  if (isStaleObservation(input.observedVersion, session.context.version)) {
    trace.add('staleness', 'reject', `observed version ${input.observedVersion}, current ${session.context.version}`);
    return finish(
      bumpCounter(session, 'staleContext'),
      'rejected',
      'The clinical context changed while this was being recognized, so it was not written to the newer location.',
    );
  }
  trace.add('staleness', 'pass', `context version ${session.context.version}`);

  /* -------- 3. lexicon (safe vocabulary only) -------- */
  const safe = canonicalize(input.transcript);
  if (safe.tokens.length === 0) {
    trace.add('lexicon', 'reject', 'empty transcript');
    return finish(session, 'ignored', 'Empty transcript ignored.');
  }
  trace.add(
    'lexicon',
    safe.replacements.length > 0 ? 'adjust' : 'pass',
    safe.replacements.length > 0
      ? safe.replacements.map((item) => `${item.from}→${item.to}`).join(', ')
      : 'already canonical',
  );

  /* -------- 4. lattice -------- */
  let nodes = buildLattice(safe.tokens, { words: input.words });
  const acoustic = acousticConfidence(nodes);
  trace.add('lattice', 'pass', `${nodes.length} node(s), ${countCandidates(nodes)} candidate(s)`);

  /* -------- 5. relevance -------- */
  const relevance = classifyRelevance(nodes, session.context, {
    acoustic,
    audioMs: input.audioMs,
    source: input.source,
  });
  let scored = countRelevance(session, relevance);
  // `enforce` and `balanced` both keep clearly non-clinical speech out; only
  // `shadow` lets it through, because shadow exists to observe a classifier
  // change without letting it touch the chart at all. `balanced` differs from
  // `enforce` only in what it does with `uncertain`: it stops holding those
  // for confirmation and instead lets the rest of the pipeline — grammar,
  // negation, correction, sequence guard, staleness — decide on its own
  // grounds, which is what makes it tolerate ordinary, imperfectly-scored
  // clinical speech without becoming permissive of chatter.
  const mode = session.settings.relevanceMode;
  const blocksNonChartable = mode !== 'shadow';
  const holdsUncertain = mode === 'enforce';
  trace.add(
    'relevance',
    relevance.label === 'chartable' ? 'pass' : relevance.label === 'uncertain' ? 'confirm' : 'block',
    `${relevance.label} (${relevance.score}): ${explainRelevance(relevance)}`,
  );
  if (relevance.label === 'non_chartable' && blocksNonChartable) {
    return finish(scored, 'ignored', 'Speech contained non-charting language, so no clinical values were changed.');
  }
  if (relevance.label === 'uncertain' && holdsUncertain && approved.relevance !== true) {
    scored = addPending(scored, {
      reason: 'uncertain_relevance',
      transcript: input.transcript,
      message: `Unclear whether this was clinical: ${explainRelevance(relevance)}`,
      createdAt: at,
      input,
    });
    return finish(scored, 'confirmation', 'Held for confirmation: unclear whether this was clinical speech.');
  }

  /* -------- 6. lexicon (contextual variants, now that it is clinical) -------- */
  const contextual = canonicalize(input.transcript, { contextual: true });
  const risky = contextual.replacements.filter((item) => item.risk === 'contextual');
  if (risky.length > 0) {
    nodes = buildLattice(contextual.tokens, { words: input.words });
    trace.add('lexicon', 'adjust', `contextual: ${risky.map((item) => `${item.from}→${item.to}`).join(', ')}`);
  }

  /* -------- 7. context-aware disambiguation -------- */
  const resolution = resolveWithContext(nodes, session.context);
  trace.add(
    'context',
    resolution.ambiguities.length > 0 ? 'adjust' : 'pass',
    resolution.ambiguities.length > 0
      ? resolution.ambiguities.map((item) => item.chosen).join(', ')
      : 'no ambiguity',
  );
  if (input.strictAutoChart && resolution.ambiguities.length > 0) {
    trace.add('context', 'reject', 'strict automatic charting does not resolve acoustically ambiguous words');
    return finish(
      scored,
      'rejected',
      'Automatic charting requires an unambiguous directive; repeat this station as a normal phrase.',
    );
  }

  /* -------- 8. grammar -------- */
  let parse = parseIntents(resolution.tokens, session.context);
  let rereadFrom: string | null = null;

  // The recognizer often cannot separate short clinical words on sound alone and
  // returns several readings at the same confidence. When the best one carries no
  // clinical meaning, the context can pick among the rest — which is the whole
  // reason the alternatives are requested. A reading that already parsed is never
  // overridden, so this can only recover an utterance, never redirect one.
  if (parse.intents.length === 0 && (input.alternatives?.length ?? 0) > 0) {
    for (const alternative of input.alternatives ?? []) {
      if (alternative.text.trim() === '' || alternative.text === input.transcript) continue;
      const retryTokens = canonicalize(alternative.text, { contextual: true }).tokens;
      const retry = parseIntents(
        resolveWithContext(buildLattice(retryTokens, { words: input.words }), session.context).tokens,
        session.context,
      );
      if (retry.intents.length > 0) {
        parse = retry;
        rereadFrom = alternative.text;
        break;
      }
    }
  }
  if (rereadFrom !== null) {
    trace.add('grammar', 'adjust', `re-read as "${rereadFrom}" from recognizer alternatives`);
  }
  if (input.strictAutoChart && parse.leftover.length > 0) {
    trace.add('grammar', 'reject', `${parse.leftover.length} unparsed token(s) in strict automatic charting`);
    return finish(
      scored,
      'rejected',
      'Automatic charting requires every word in a directive to be understood.',
    );
  }
  trace.add(
    'grammar',
    parse.intents.length > 0 ? 'pass' : 'reject',
    parse.intents.length > 0
      ? parse.intents.map(describeIntentShort).join(' + ')
      : 'no clinical intent',
  );
  if (parse.intents.length === 0) {
    if (parse.problems.length > 0) {
      return finish(scored, 'rejected', parse.problems[0]);
    }
    return finish(scored, 'ignored', 'No chartable periodontal command was detected.');
  }

  /* -------- 9..12. apply intents -------- */
  let working = scored;
  const changes: ChartChange[] = [];
  const messages: string[] = [];
  let kind: ClinicalEventKind = 'context';
  let supersedes: number | null = null;
  let compensates: number | null = null;
  let latencyEligible = false;

  for (const intent of parse.intents) {
    const outcome = applyIntent(working, intent, input, trace, parse, approved);
    working = outcome.session;
    if (outcome.message !== '') messages.push(outcome.message);
    changes.push(...outcome.changes);
    if (outcome.latencyEligible) latencyEligible = true;
    if (outcome.supersedes !== null) supersedes = outcome.supersedes;
    if (outcome.compensates !== null) compensates = outcome.compensates;
    kind = outcome.kind;
    if (outcome.stop) {
      return finish(working, outcome.kind, messages.join(' '), {
        changes: outcome.kind === 'rejected' ? [] : changes,
        latencyEligible: outcome.kind === 'rejected' ? false : latencyEligible,
        supersedes,
        compensates,
      });
    }
  }

  return finish(working, kind, messages.join(' '), {
    changes,
    latencyEligible,
    supersedes,
    compensates,
  });
}

function countCandidates(nodes: ReturnType<typeof buildLattice>): number {
  return nodes.reduce((sum, node) => sum + node.candidates.length, 0);
}

function countRelevance(session: ClinicalSession, decision: RelevanceDecision): ClinicalSession {
  if (decision.label === 'chartable') return bumpCounter(session, 'chartable');
  if (decision.label === 'uncertain') return bumpCounter(session, 'uncertain');
  return bumpCounter(session, 'nonChartable');
}

function describeIntentShort(intent: Intent): string {
  return intent.kind;
}

function passthrough(session: ClinicalSession, kind: ClinicalEventKind, message: string): Outcome {
  return {
    session,
    kind,
    message,
    changes: [],
    latencyEligible: false,
    supersedes: null,
    compensates: null,
    stop: false,
  };
}

function halt(session: ClinicalSession, kind: ClinicalEventKind, message: string): Outcome {
  return {
    session,
    kind,
    message,
    changes: [],
    latencyEligible: false,
    supersedes: null,
    compensates: null,
    stop: true,
  };
}

function applyIntent(
  session: ClinicalSession,
  intent: Intent,
  input: UtteranceInput,
  trace: Trace,
  parse: ParseResult,
  approved: PipelineOverrides,
): Outcome {
  const at = input.timing.observedAt;
  switch (intent.kind) {
    case 'context':
      return applyContext(session, intent, at, trace);
    case 'command':
      return applyCommand(session, intent, at, trace);
    case 'measurements':
    case 'replace_sequence':
      return applyValues(session, intent, at, trace, approved);
    case 'correction':
      return applyCorrection(session, intent, input, trace, approved);
    case 'findings':
      return applyFindings(session, intent.assertions, input, trace, parse, approved);
  }
}

function applyContext(
  session: ClinicalSession,
  intent: Extract<Intent, { kind: 'context' }>,
  at: number,
  trace: Trace,
): Outcome {
  const move = jumpToStation(session.context, session.workflow, session.charts, {
    tooth: intent.tooth ?? undefined,
    surface: intent.surface ?? undefined,
  });
  if (!move.changed && move.message.includes('between 1 and 32')) {
    trace.add('commit', 'reject', `tooth ${intent.tooth ?? '—'} is outside 1–32`);
    return halt(session, 'rejected', move.message);
  }
  trace.add('commit', 'pass', `tooth ${move.context.tooth} ${move.context.surface}, version ${move.context.version}`);
  void at;
  return passthrough(
    { ...session, context: move.context, workflow: move.workflow },
    'context',
    move.message,
  );
}

function applyCommand(
  session: ClinicalSession,
  intent: Extract<Intent, { kind: 'command' }>,
  at: number,
  trace: Trace,
): Outcome {
  switch (intent.command) {
    case 'next':
    case 'back':
    case 'resume': {
      const move =
        intent.command === 'next'
          ? advanceStation(session.context, session.workflow, session.charts)
          : intent.command === 'back'
            ? retreatStation(session.context, session.workflow, session.charts)
            : resumeStation(session.context, session.workflow, session.charts);
      trace.add(
        'commit',
        move.changed ? 'pass' : 'reject',
        `${intent.command} → tooth ${move.context.tooth} ${move.context.surface}`,
      );
      return passthrough(
        { ...session, context: move.context, workflow: move.workflow },
        'context',
        move.message,
      );
    }
    case 'skip': {
      const tooth = intent.tooth ?? session.context.tooth;
      const move = skipTooth(session.context, session.workflow, session.charts, tooth);
      const change: ChartChange = {
        tooth,
        surface: null,
        field: 'missing',
        siteIndex: null,
        before: session.teeth[tooth]?.missing ?? false,
        after: true,
      };
      trace.add('commit', 'pass', `tooth ${tooth} marked absent`);
      const next = commitChanges(
        { ...session, context: move.context, workflow: move.workflow },
        [change],
        at,
      );
      return {
        session: next,
        kind: 'context',
        message: move.message,
        changes: [change],
        latencyEligible: false,
        supersedes: null,
        compensates: null,
        stop: false,
      };
    }
    case 'clear':
      return applyClear(session, at, trace);
    case 'undo':
      return applyUndo(session, at, trace);
    case 'redo':
      return applyRedo(session, at, trace);
    case 'confirm':
    case 'deny':
      return answerConfirmation(session, intent.command === 'confirm', at, trace);
    case 'pause':
    case 'start':
      return applyContinuousToggle(session, intent.command, trace);
  }
}

/**
 * "chart" / "deny" answer the newest held confirmation by voice, exactly as the
 * approve / discard controls do: approval replays the held utterance through
 * the whole pipeline with its override (so the value is audited like a spoken
 * one), denial records it as ignored. With nothing held, nothing changes.
 */
function answerConfirmation(
  session: ClinicalSession,
  approve: boolean,
  at: number,
  trace: Trace,
): Outcome {
  const newest = session.pending[session.pending.length - 1];
  if (newest === undefined) {
    trace.add('commit', 'reject', 'no confirmation is waiting');
    return passthrough(session, 'confirmation', 'Nothing is waiting for confirmation.');
  }
  trace.add('commit', 'pass', approve ? 'held item approved by voice' : 'held item denied by voice');
  return passthrough(
    resolveConfirmation(session, newest.id, approve, at),
    'confirmation',
    approve ? 'Charted the held item.' : 'Discarded the held item; nothing was charted.',
  );
}

/**
 * Toggles continuous charting by voice. This is a settings change, not a
 * chart write: it produces no `ChartChange`, so — consistent with `next`,
 * `back`, `resume` and `confirm`, none of which touch the journal either —
 * it is not undoable. It is still recorded in `history` with a full stage
 * trace, so the toggle is auditable and visible like any other command. It
 * never touches `session.context`, so it cannot bump `context.version`.
 */
function applyContinuousToggle(
  session: ClinicalSession,
  command: 'pause' | 'start',
  trace: Trace,
): Outcome {
  const autoAdvance = command === 'start';
  if (session.settings.autoAdvance === autoAdvance) {
    trace.add('commit', 'pass', `continuous charting already ${autoAdvance ? 'on' : 'off'}`);
    return passthrough(
      session,
      'context',
      `Continuous charting is already ${autoAdvance ? 'on' : 'off'}.`,
    );
  }
  trace.add('commit', 'pass', `continuous charting ${autoAdvance ? 'on' : 'off'}`);
  return passthrough(
    { ...session, settings: { ...session.settings, autoAdvance } },
    'context',
    `Continuous charting turned ${autoAdvance ? 'on' : 'off'}.`,
  );
}

function applyClear(session: ClinicalSession, at: number, trace: Trace): Outcome {
  const { tooth, surface, measurement } = session.context;
  const record = recordAt(session.charts, tooth, surface);
  const values = measurementValues(record, measurement);
  const changes: ChartChange[] = [];
  values.forEach((value, index) => {
    if (value !== null) {
      changes.push({
        tooth,
        surface,
        field: measurement === 'recession' ? 'recession' : 'probingDepths',
        siteIndex: index,
        before: value,
        after: null,
      });
    }
  });
  for (const field of ['bleeding', 'suppuration', 'plaque', 'calculus'] as const) {
    if (record[field] !== null) {
      changes.push({ tooth, surface, field, siteIndex: null, before: record[field], after: null });
    }
  }
  const next = commitChanges(session, changes, at);
  const message = `Cleared tooth ${tooth}, ${surface}.`;
  trace.add('commit', 'pass', `${changes.length} value(s) cleared`);
  return {
    session: { ...next, context: { ...next.context, position: 0 } },
    kind: 'context',
    message,
    changes,
    latencyEligible: false,
    supersedes: null,
    compensates: null,
    stop: false,
  };
}

function applyUndo(session: ClinicalSession, at: number, trace: Trace): Outcome {
  const entry = undoableEntry(session.journal);
  if (entry === null) {
    trace.add('commit', 'reject', 'nothing to undo');
    return halt(session, 'rejected', 'There is nothing to undo in this session.');
  }
  const inverse = invertChanges(entry.changes);
  const next = commitChanges({ ...session, journal: markUndone(session.journal, entry.id, true) }, inverse, at);
  const message = `Reversed “${entry.transcript}”.`;
  trace.add('commit', 'pass', `reversed journal entry ${entry.id}, ${inverse.length} change(s)`);
  return {
    session: refreshPosition(next),
    kind: 'undo',
    message,
    changes: inverse,
    latencyEligible: false,
    supersedes: null,
    compensates: entry.id,
    stop: false,
  };
}

function applyRedo(session: ClinicalSession, at: number, trace: Trace): Outcome {
  const entry = redoableEntry(session.journal);
  if (entry === null) {
    trace.add('commit', 'reject', 'nothing to redo');
    return halt(session, 'rejected', 'There is nothing to redo in this session.');
  }
  const next = commitChanges(
    { ...session, journal: markUndone(session.journal, entry.id, false) },
    entry.changes,
    at,
  );
  const message = `Reapplied “${entry.transcript}”.`;
  trace.add('commit', 'pass', `reapplied journal entry ${entry.id}, ${entry.changes.length} change(s)`);
  return {
    session: refreshPosition(next),
    kind: 'redo',
    message,
    changes: [...entry.changes],
    latencyEligible: false,
    supersedes: null,
    compensates: entry.id,
    stop: false,
  };
}

function applyValues(
  session: ClinicalSession,
  intent: Extract<Intent, { kind: 'measurements' | 'replace_sequence' }>,
  at: number,
  trace: Trace,
  approved: PipelineOverrides = {},
): Outcome {
  const advanced = maybeAdvanceForValues(session, intent, trace);
  const { tooth, surface } = advanced.context;
  const record = recordAt(advanced.charts, tooth, surface);
  session = advanced;
  const verdict = guardIntent(intent, session.context, record);
  // Trace details stay structural rather than repeating the message, so the
  // explanation adds information instead of echoing it.
  const shape = `${intent.values.length} value(s), ${SITES_PER_STATION - nextOpenPosition(record, intent.measurement)} site(s) open`;
  if (verdict.outcome === 'reject') {
    trace.add('sequence', 'reject', `${verdict.code} — ${shape}`);
    return halt(session, 'rejected', verdict.reason);
  }
  if (verdict.outcome === 'confirm' && approved.overwrite !== true) {
    trace.add('sequence', 'confirm', `${verdict.code} — ${shape}`);
    return halt(session, 'confirmation', verdict.reason);
  }
  trace.add('sequence', 'pass', `${shape}, placing at ${verdict.placements.map((index) => index + 1).join(', ')}`);

  const field = intent.measurement === 'recession' ? 'recession' : 'probingDepths';
  const existing = measurementValues(record, intent.measurement);
  const changes: ChartChange[] = [];

  if (intent.kind === 'replace_sequence') {
    for (let index = 0; index < SITES_PER_STATION; index += 1) {
      changes.push({
        tooth,
        surface,
        field,
        siteIndex: index,
        before: existing[index],
        after: intent.values[index],
      });
    }
  } else {
    verdict.placements.forEach((placement, offset) => {
      changes.push({
        tooth,
        surface,
        field,
        siteIndex: placement,
        before: existing[placement],
        after: intent.values[offset],
      });
    });
  }

  const next = refreshPosition(commitChanges(session, changes, at));
  const message =
    intent.kind === 'replace_sequence'
      ? `Replaced the active sequence with ${intent.values.join(' / ')} mm.`
      : describePlacement(intent.values, verdict.placements);
  trace.add('commit', 'pass', `${changes.length} change(s) on tooth ${tooth} ${surface}`);
  return {
    session: next,
    kind: intent.kind === 'replace_sequence' ? 'sequence_replacement' : measurementKind(intent.measurement),
    message,
    changes,
    latencyEligible: true,
    supersedes: null,
    compensates: null,
    stop: false,
  };
}

function measurementKind(measurement: MeasurementType): ClinicalEventKind {
  return measurement === 'recession' ? 'recession_sequence' : 'depth_sequence';
}

function describePlacement(values: readonly number[], placements: readonly number[]): string {
  const first = placements[0] + 1;
  const span = values.length > 1 ? `s ${first}–${placements[placements.length - 1] + 1}` : ` ${first}`;
  return `Recorded ${values.join(' / ')} mm at position${span}.`;
}

function applyCorrection(
  session: ClinicalSession,
  intent: Extract<Intent, { kind: 'correction' }>,
  input: UtteranceInput,
  trace: Trace,
  approved: PipelineOverrides = {},
): Outcome {
  const at = input.timing.observedAt;
  const record = recordAt(session.charts, session.context.tooth, session.context.surface);
  const verdict = guardIntent(intent, session.context, record);
  if (verdict.outcome === 'reject' && verdict.code === 'out_of_range') {
    trace.add('sequence', 'reject', verdict.reason);
    return halt(session, 'rejected', verdict.reason);
  }

  const plan = resolveCorrection({
    journal: session.journal,
    charts: session.charts,
    context: session.context,
    measurement: intent.measurement,
    target: intent.target,
    value: intent.value,
    now: at,
  });
  if (plan.outcome === 'reject') {
    trace.add('correction', 'reject', plan.reason);
    return halt(session, 'rejected', plan.reason);
  }
  if (plan.outcome === 'confirm' && approved.correction !== true) {
    trace.add('correction', 'confirm', plan.reason);
    const held = addPending(session, {
      reason: 'ambiguous_correction',
      transcript: input.transcript,
      message: `Correction ${plan.reason}: replace ${plan.previous ?? '—'} mm with ${intent.value} mm at tooth ${plan.tooth} ${plan.surface} site ${plan.siteIndex + 1}?`,
      createdAt: at,
      input,
    });
    return halt(held, 'confirmation', `Held for confirmation: correction ${plan.reason}.`);
  }

  const change: ChartChange = {
    tooth: plan.tooth,
    surface: plan.surface,
    field: intent.measurement === 'recession' ? 'recession' : 'probingDepths',
    siteIndex: plan.siteIndex,
    before: plan.previous,
    after: intent.value,
  };
  const next = refreshPosition(commitChanges(session, [change], at));
  const message = describeCorrection(plan, intent.value, `site ${plan.siteIndex + 1}`);
  trace.add(
    'correction',
    'pass',
    `${plan.reason}; site ${plan.siteIndex + 1} ${plan.previous ?? '—'} → ${intent.value}`,
  );
  return {
    session: next,
    kind: 'correction',
    message,
    changes: [change],
    latencyEligible: true,
    supersedes: plan.targetEntryId,
    compensates: null,
    stop: false,
  };
}

function applyFindings(
  session: ClinicalSession,
  assertions: readonly FindingAssertion[],
  input: UtteranceInput,
  trace: Trace,
  parse: ParseResult,
  approved: PipelineOverrides = {},
): Outcome {
  void parse;
  const at = input.timing.observedAt;
  const verdict = guardIntent({ kind: 'findings', assertions: [...assertions] }, session.context, recordAt(session.charts, session.context.tooth, session.context.surface));
  if (verdict.outcome === 'reject') {
    trace.add('sequence', 'reject', verdict.reason);
    return halt(session, 'rejected', verdict.reason);
  }

  const uncertain = approved.polarity === true ? [] : assertions.filter(needsPolarityConfirmation);
  if (uncertain.length > 0) {
    const held = addPending(session, {
      reason: 'low_confidence_polarity',
      transcript: input.transcript,
      message: `Polarity is uncertain for ${uncertain.map(describeAssertion).join(', ')}. Confirm before charting.`,
      createdAt: at,
      input,
    });
    trace.add('negation', 'confirm', `uncertain polarity: ${uncertain.map(describeAssertion).join(', ')}`);
    return halt(held, 'confirmation', `Held for confirmation: uncertain polarity for ${uncertain.map((item) => item.finding).join(', ')}.`);
  }

  const { tooth, surface } = session.context;
  const record = recordAt(session.charts, tooth, surface);
  const changes: ChartChange[] = [];
  const messages: string[] = [];
  for (const assertion of assertions) {
    if (assertion.finding === 'mobility' || assertion.finding === 'furcation') {
      const before = session.teeth[tooth]?.[assertion.finding] ?? null;
      const after = assertion.polarity === 'positive' ? assertion.grade ?? 1 : 0;
      changes.push({ tooth, surface: null, field: assertion.finding, siteIndex: null, before, after });
      messages.push(`${titleCase(assertion.finding)} set to grade ${after}.`);
      continue;
    }
    const before = record[assertion.finding];
    const after = assertion.polarity === 'positive';
    changes.push({ tooth, surface, field: assertion.finding, siteIndex: null, before, after });
    messages.push(`${titleCase(assertion.finding)} set to ${after ? 'yes' : 'no'}.`);
  }
  trace.add('negation', 'pass', assertions.map(describeAssertion).join(', '));
  const next = commitChanges(session, changes, at);
  const message = messages.join(' ');
  trace.add('commit', 'pass', `${changes.length} finding change(s) on tooth ${tooth}`);
  return {
    session: next,
    kind: assertions.every((assertion) => assertion.finding === 'bleeding') ? 'bleeding' : 'finding',
    message,
    changes,
    latencyEligible: true,
    supersedes: null,
    compensates: null,
    stop: false,
  };
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/**
 * Continuous charting advances lazily: a completed station is only left behind
 * when the next *measurement* arrives. Advancing eagerly would send a finding
 * spoken right after the last depth — or a correction to it — to the next tooth,
 * which is exactly the kind of misplacement this system exists to prevent.
 */
function maybeAdvanceForValues(
  session: ClinicalSession,
  intent: Extract<Intent, { kind: 'measurements' | 'replace_sequence' }>,
  trace: Trace,
): ClinicalSession {
  if (!session.settings.autoAdvance) return session;
  if (intent.kind !== 'measurements' || intent.siteIndex !== null) return session;
  const record = recordAt(session.charts, session.context.tooth, session.context.surface);
  if (!isStationComplete(record, session.context.measurement)) return session;
  const move = advanceStation(session.context, session.workflow, session.charts);
  if (!move.changed) return session;
  trace.add('commit', 'adjust', move.message);
  return { ...session, context: move.context, workflow: move.workflow };
}

/** Recomputes the cursor after any write that can change which sites are open. */
function refreshPosition(session: ClinicalSession): ClinicalSession {
  const record = recordAt(session.charts, session.context.tooth, session.context.surface);
  return {
    ...session,
    context: { ...session.context, position: nextOpenPosition(record, session.context.measurement) },
  };
}

/**
 * A workflow command issued from the interface rather than spoken.
 *
 * It runs the same transition speech would, so a button and an utterance can
 * never disagree about what "back" means.
 */
export function applyWorkflowCommand(
  session: ClinicalSession,
  command: WorkflowCommand,
  occurredAt: number,
  label = 'Workflow control',
): ClinicalSession {
  const trace = new Trace();
  const outcome = applyCommand(session, { kind: 'command', command, tooth: null }, occurredAt, trace);
  return recordEvent(outcome.session, {
    kind: outcome.kind,
    transcript: label,
    message: outcome.message,
    occurredAt,
    latencyMs: null,
    trace: trace.snapshot(),
    changes: outcome.changes,
    compensates: outcome.compensates ?? undefined,
  });
}

/**
 * Settles a held confirmation.
 *
 * Approving replays the original utterance with the operator's approval
 * attached, so the value reaches the chart through the same stages as any other
 * utterance and the audit trail shows why it was allowed.
 */
export function resolveConfirmation(
  session: ClinicalSession,
  id: number,
  approve: boolean,
  occurredAt: number,
): ClinicalSession {
  const pending = findPending(session, id);
  if (pending === null) return session;
  const cleared = removePending(session, id);
  if (!approve) {
    return recordEvent(cleared, {
      kind: 'ignored',
      transcript: pending.transcript,
      message: `Discarded after review: ${pending.message}`,
      occurredAt,
      latencyMs: null,
      trace: [
        { stage: 'commit', outcome: 'block', detail: 'operator declined', durationMs: 0 },
      ],
    });
  }
  return processUtterance(cleared, {
    ...pending.input,
    timing: { startedAt: pending.input.timing.startedAt, observedAt: occurredAt },
    observedVersion: null,
    overrides: {
      speaker: true,
      relevance: true,
      polarity: true,
      overwrite: true,
      correction: true,
    },
  });
}

export { siteName, entryForSite };
