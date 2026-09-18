/**
 * Strict multi-station automatic charting.
 *
 * A normal final stays on the established single-utterance pipeline. When a
 * clinician deliberately separates two or more directives with a semicolon or
 * newline, this module evaluates every directive against a shadow session and
 * publishes it only when every one is safe. There is deliberately no model,
 * fetch, or timer in this path: the existing deterministic NLP stack remains
 * the source of truth and an unsafe batch changes nothing.
 */

import { parseIntents } from './grammar';
import { canonicalize } from './lexicon';
import { buildLattice } from './lattice';
import { processUtterance } from './pipeline';
import { resolveWithContext } from './contextResolver';
import {
  inspectTransaction,
  rememberTransaction,
  observedVersionOf,
  recordEvent,
  recordParserDuration,
} from './session';
import type { ClinicalSession, UtteranceInput } from './types';

export type AutoChartMode = 'single' | 'batch';
export type AutoChartDecision = 'committed' | 'rejected';

export interface AutoChartResult {
  session: ClinicalSession;
  mode: AutoChartMode;
  decision: AutoChartDecision;
  clauses: number;
  reason: string | null;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Only explicit separators opt into a multi-station transaction. */
export function splitAutoChartClauses(transcript: string): string[] {
  return transcript
    .split(/[;\n]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/**
 * A batch directive must name its own station. Inheriting a previous clause's
 * station would make a missing phrase look plausible and is therefore reserved
 * for the existing one-utterance flow, where it is visible to the operator.
 */
function hasExplicitStation(clause: string, session: ClinicalSession): boolean {
  const safe = canonicalize(clause);
  if (safe.tokens.length === 0) return false;
  const resolution = resolveWithContext(buildLattice(safe.tokens), session.context);
  const parsed = parseIntents(resolution.tokens, session.context);
  return parsed.intents.some(
    (intent) => intent.kind === 'context' && intent.tooth !== null && intent.surface !== null,
  );
}

function rejectBatch(
  session: ClinicalSession,
  input: UtteranceInput,
  clauses: number,
  reason: string,
  started: number,
  registerTransaction = true,
): AutoChartResult {
  const durationMs = Math.round((now() - started) * 100) / 100;
  const check = inspectTransaction(session, input);
  const rejected = recordEvent(session, {
    kind: 'rejected',
    transcript: input.transcript,
    message: `Automatic charting refused: ${reason}`,
    occurredAt: input.timing.observedAt,
    latencyMs: null,
    trace: [{ stage: 'auto_chart', outcome: 'reject', detail: reason, durationMs }],
    transaction: check.identity,
    lifecycle: 'held',
    decision: 'rejected',
  });
  const settled = registerTransaction
    ? rememberTransaction(
        rejected,
        input,
        'rejected',
        'held',
        rejected.history[0]?.id ?? null,
        rejected.history[0]?.journalEntryId ?? null,
        input.timing.observedAt,
        check.identity,
      )
    : rejected;
  return {
    session: recordParserDuration(settled, durationMs),
    mode: 'batch',
    decision: 'rejected',
    clauses,
    reason,
  };
}

/**
 * Process a recognition final. Single statements retain the normal permissive
 * clinician workflow; only a deliberately delimited batch takes the strict,
 * atomic auto-chart route.
 */
export function processAutoChart(
  session: ClinicalSession,
  input: UtteranceInput,
): AutoChartResult {
  const clauses = splitAutoChartClauses(input.transcript);
  if (clauses.length < 2) {
    const transaction = inspectTransaction(session, input);
    if (transaction.state === 'duplicate') {
      const prior = transaction.previous;
      return {
        session,
        mode: 'single',
        decision: prior?.decision === 'committed' ? 'committed' : 'rejected',
        clauses: 1,
        reason: prior?.decision === 'committed'
          ? null
          : 'duplicate transaction returned its prior protected decision',
      };
    }
    const next = processUtterance(session, input);
    const event = next.history[0];
    return {
      session: next,
      mode: 'single',
      decision: event?.decision === 'committed' ? 'committed' : 'rejected',
      clauses: 1,
      reason: event?.decision === 'committed' ? null : event?.message ?? 'single transaction was protected',
    };
  }

  const started = now();
  const transaction = inspectTransaction(session, input);
  const missingAsrContext = input.source === 'asr'
    && transaction.identity !== null
    && observedVersionOf(input) === null;
  if (missingAsrContext) {
    return rejectBatch(
      session,
      input,
      clauses.length,
      'transaction-bearing ASR input requires an observed context version',
      started,
      false,
    );
  }
  if (transaction.state === 'duplicate') {
    const prior = transaction.previous;
    return {
      session,
      mode: 'batch',
      decision: prior?.decision === 'committed' ? 'committed' : 'rejected',
      clauses: clauses.length,
      reason: prior?.decision === 'committed'
        ? null
        : 'duplicate transaction returned its prior protected decision',
    };
  }
  if (transaction.state === 'conflict') {
    return rejectBatch(
      session,
      input,
      clauses.length,
      'transaction identity was reused with different clinical content',
      started,
      false,
    );
  }
  const priorEventIds = new Set(session.history.map((event) => event.id));
  const priorJournalIds = new Set(session.journal.map((entry) => entry.id));
  for (let index = 0; index < clauses.length; index += 1) {
    if (!hasExplicitStation(clauses[index], session)) {
      return rejectBatch(
        session,
        input,
        clauses.length,
        `clause ${index + 1} must explicitly name both a tooth and a surface.`,
        started,
      );
    }
  }

  let candidate = session;
  for (let index = 0; index < clauses.length; index += 1) {
    const clauseInput: UtteranceInput = {
      ...input,
      transcript: clauses[index],
      // The original final observes the live context. Later directives run only
      // against the private shadow transaction, so they cannot be stale merely
      // because an earlier directive changed its own temporary context.
      observedVersion: index === 0 ? input.observedVersion : null,
      alternatives: undefined,
      strictAutoChart: true,
      // A batch is one transaction. Only its first shadow clause owns the
      // outer identity; later clauses are private work and must not look like
      // duplicate finals with the same id.
      transactionId: index === 0 ? input.transactionId : null,
      streamId: index === 0 ? input.streamId : null,
      utteranceId: index === 0 ? input.utteranceId : null,
      revision: index === 0 ? input.revision : undefined,
      originalContextVersion: index === 0 ? input.originalContextVersion : null,
      replayOfTransaction: index === 0 ? input.replayOfTransaction : undefined,
    };
    candidate = processUtterance(candidate, clauseInput);
    const event = candidate.history[0];
    if (event === undefined || event.kind === 'rejected' || event.kind === 'ignored'
        || event.kind === 'confirmation' || event.journalEntryId === null) {
      return rejectBatch(
        session,
        input,
        clauses.length,
        `clause ${index + 1} did not produce one unambiguous chart change: ${event?.message ?? 'no clinical action'}`,
        started,
      );
    }
  }

  if (transaction.identity !== null) {
    const identity = transaction.identity;
    candidate = {
      ...candidate,
      // A batch is one durable transaction even though each directive was
      // evaluated through the ordinary pipeline on a private shadow session.
      history: candidate.history.map((event) =>
        priorEventIds.has(event.id)
          ? event
          : {
              ...event,
              transaction: event.transaction ?? identity,
              transactionId: identity.transactionId,
              streamId: identity.streamId,
              utteranceId: identity.utteranceId,
              revision: identity.revision,
              observedVersion: identity.observedVersion,
              originalContextVersion: identity.originalContextVersion,
            },
      ),
      journal: candidate.journal.map((entry) =>
        priorJournalIds.has(entry.id)
          ? entry
          : {
              ...entry,
              transactionId: identity.transactionId,
              streamId: identity.streamId,
              utteranceId: identity.utteranceId,
              revision: identity.revision,
              observedVersion: identity.observedVersion,
              originalContextVersion: identity.originalContextVersion,
            },
      ),
    };
  }
  const outerEvent = candidate.history.find(
    (event) => event.transaction?.transactionId === transaction.identity?.transactionId,
  );
  candidate = rememberTransaction(
    candidate,
    input,
    'committed',
    'confirmed',
    outerEvent?.id ?? null,
    outerEvent?.journalEntryId ?? null,
    input.timing.observedAt,
    transaction.identity,
  );

  return {
    session: candidate,
    mode: 'batch',
    decision: 'committed',
    clauses: clauses.length,
    reason: null,
  };
}
