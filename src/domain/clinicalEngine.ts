/**
 * Public clinical engine façade.
 *
 * The engine is the boundary the interface and the evaluation harness talk to.
 * It stays pure and recognition-independent: a transcript and its timing go in,
 * a new immutable session comes out. Everything underneath is the staged
 * pipeline in `pipeline.ts`.
 */

import { processUtterance } from './pipeline';
import { recordEvent } from './session';
import { jumpToStation } from './workflow';
import { measurementValues, recordAt } from './chart';
import type {
  ChartChange,
  ClinicalSession,
  ContextPatch,
  PerioRecord,
  TranscriptTiming,
  UtteranceInput,
} from './types';
import { commitChanges } from './session';

export { chartKey, emptyRecord } from './chart';
export { createInitialSession, latencySummary, percentile } from './session';
export { processUtterance } from './pipeline';

export function currentRecord(session: ClinicalSession): PerioRecord {
  return recordAt(session.charts, session.context.tooth, session.context.surface);
}

/** Builds the pipeline input for a transcript that arrived without ASR metadata. */
export function simulatorInput(transcript: string, timing: TranscriptTiming): UtteranceInput {
  return {
    transcript,
    words: [],
    timing,
    source: 'simulator',
    utteranceId: null,
    audioMs: null,
    decodeMs: null,
    observedVersion: null,
    speaker: null,
  };
}

export function applyTranscript(
  session: ClinicalSession,
  transcript: string,
  timing: TranscriptTiming,
): ClinicalSession {
  return processUtterance(session, simulatorInput(transcript, timing));
}

/** Operator-driven context change from the interface rather than from speech. */
export function updateContext(
  session: ClinicalSession,
  patch: ContextPatch,
  occurredAt: number,
  transcript = 'Context control',
): ClinicalSession {
  const move = jumpToStation(session.context, session.workflow, session.charts, {
    tooth: patch.tooth,
    surface: patch.surface,
  });
  if (!move.changed && move.message.includes('between 1 and 32')) {
    return recordEvent(session, {
      kind: 'rejected',
      transcript,
      message: move.message,
      occurredAt,
      latencyMs: null,
      trace: [{ stage: 'commit', outcome: 'reject', detail: move.message, durationMs: 0 }],
    });
  }
  return recordEvent(
    { ...session, context: move.context, workflow: move.workflow },
    {
      kind: 'context',
      transcript,
      message: move.message,
      occurredAt,
      latencyMs: null,
      trace: [{ stage: 'commit', outcome: 'pass', detail: move.message, durationMs: 0 }],
    },
  );
}

export function clearCurrentRecord(
  session: ClinicalSession,
  occurredAt: number,
): ClinicalSession {
  const { tooth, surface, measurement } = session.context;
  const record = recordAt(session.charts, tooth, surface);
  const changes: ChartChange[] = [];
  measurementValues(record, measurement).forEach((value, index) => {
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
  const cleared = commitChanges(session, changes, occurredAt);
  return recordEvent(
    { ...cleared, context: { ...cleared.context, position: 0 } },
    {
      kind: 'context',
      transcript: 'Clear active record',
      message: `Cleared tooth ${tooth}, ${surface}.`,
      occurredAt,
      latencyMs: null,
      trace: [{ stage: 'commit', outcome: 'pass', detail: 'cleared active record', durationMs: 0 }],
      changes,
    },
  );
}
