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
import { recordEvent, recordParserDuration } from './session';
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
): AutoChartResult {
  const durationMs = Math.round((now() - started) * 100) / 100;
  const rejected = recordEvent(session, {
    kind: 'rejected',
    transcript: input.transcript,
    message: `Automatic charting refused: ${reason}`,
    occurredAt: input.timing.observedAt,
    latencyMs: null,
    trace: [{ stage: 'auto_chart', outcome: 'reject', detail: reason, durationMs }],
  });
  return {
    session: recordParserDuration(rejected, durationMs),
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
    return {
      session: processUtterance(session, input),
      mode: 'single',
      decision: 'committed',
      clauses: 1,
      reason: null,
    };
  }

  const started = now();
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

  return {
    session: candidate,
    mode: 'batch',
    decision: 'committed',
    clauses: clauses.length,
    reason: null,
  };
}
