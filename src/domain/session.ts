/** Session construction and the immutable helpers every stage commits through. */

import { emptyRecord, chartKey } from './chart';
import { applyChanges, type ChartState } from './journal';
import { createWorkflow } from './workflow';
import type {
  ChartChange,
  ClinicalContext,
  ClinicalEvent,
  ClinicalEventKind,
  ClinicalSession,
  JournalEntry,
  PendingConfirmation,
  SessionSettings,
  StageTrace,
  UtteranceInput,
} from './types';

export const DEFAULT_SETTINGS: SessionSettings = {
  autoAdvance: false,
  relevanceMode: 'enforce',
  requireSpeaker: false,
};

export const INITIAL_TOOTH = 14;
export const MAX_HISTORY = 100;
export const MAX_JOURNAL = 500;
export const MAX_LATENCY_SAMPLES = 200;

export function createInitialSession(
  settings: Partial<SessionSettings> = {},
): ClinicalSession {
  const context: ClinicalContext = {
    tooth: INITIAL_TOOTH,
    surface: 'buccal',
    measurement: 'probing_depth',
    expectedValues: 3,
    position: 0,
    version: 1,
  };
  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    context,
    workflow: createWorkflow(context.tooth, context.surface),
    charts: { [chartKey(context.tooth, context.surface)]: emptyRecord(context.tooth, context.surface) },
    teeth: {},
    history: [],
    journal: [],
    pending: [],
    latencySamples: [],
    parserSamples: [],
    counters: {
      chartable: 0,
      nonChartable: 0,
      uncertain: 0,
      blockedSpeaker: 0,
      staleContext: 0,
    },
    nextEventId: 1,
    nextJournalId: 1,
    nextConfirmationId: 1,
  };
}

export function chartStateOf(session: ClinicalSession): ChartState {
  return { charts: session.charts, teeth: session.teeth };
}

export function withChartState(session: ClinicalSession, state: ChartState): ClinicalSession {
  return { ...session, charts: state.charts, teeth: state.teeth };
}

export function commitChanges(
  session: ClinicalSession,
  changes: readonly ChartChange[],
  at: number,
): ClinicalSession {
  if (changes.length === 0) return session;
  return withChartState(session, applyChanges(chartStateOf(session), changes, at));
}

export interface EventDraft {
  kind: ClinicalEventKind;
  transcript: string;
  message: string;
  occurredAt: number;
  latencyMs: number | null;
  trace: StageTrace[];
  changes?: readonly ChartChange[];
  supersedes?: number | null;
  compensates?: number | null;
}

/**
 * Appends one audit event and, when the utterance wrote something, the journal
 * entry that records exactly what changed.
 */
export function recordEvent(session: ClinicalSession, draft: EventDraft): ClinicalSession {
  const changes = draft.changes ?? [];
  const writesJournal = changes.length > 0 || draft.compensates !== undefined;
  const journalId = writesJournal ? session.nextJournalId : null;

  let journal = session.journal;
  if (writesJournal) {
    const entry: JournalEntry = {
      id: session.nextJournalId,
      transcript: draft.transcript,
      kind: draft.kind,
      changes: [...changes],
      occurredAt: draft.occurredAt,
      supersededBy: null,
      compensates: draft.compensates ?? null,
      undone: false,
    };
    journal = [...journal, entry].slice(-MAX_JOURNAL);
    if (draft.supersedes !== undefined && draft.supersedes !== null) {
      const supersededBy = entry.id;
      journal = journal.map((candidate) =>
        candidate.id === draft.supersedes ? { ...candidate, supersededBy } : candidate,
      );
    }
  }

  const event: ClinicalEvent = {
    id: session.nextEventId,
    kind: draft.kind,
    transcript: draft.transcript,
    message: draft.message,
    occurredAt: draft.occurredAt,
    latencyMs: draft.latencyMs,
    trace: draft.trace,
    journalEntryId: journalId,
  };

  return {
    ...session,
    journal,
    history: [event, ...session.history].slice(0, MAX_HISTORY),
    latencySamples:
      draft.latencyMs === null
        ? session.latencySamples
        : [...session.latencySamples, draft.latencyMs].slice(-MAX_LATENCY_SAMPLES),
    nextEventId: session.nextEventId + 1,
    nextJournalId: writesJournal ? session.nextJournalId + 1 : session.nextJournalId,
  };
}

export function recordParserDuration(session: ClinicalSession, durationMs: number): ClinicalSession {
  return {
    ...session,
    parserSamples: [...session.parserSamples, durationMs].slice(-MAX_LATENCY_SAMPLES),
  };
}

export function addPending(
  session: ClinicalSession,
  confirmation: Omit<PendingConfirmation, 'id'>,
): ClinicalSession {
  return {
    ...session,
    pending: [...session.pending, { ...confirmation, id: session.nextConfirmationId }],
    nextConfirmationId: session.nextConfirmationId + 1,
  };
}

export function removePending(session: ClinicalSession, id: number): ClinicalSession {
  return { ...session, pending: session.pending.filter((item) => item.id !== id) };
}

export function findPending(session: ClinicalSession, id: number): PendingConfirmation | null {
  return session.pending.find((item) => item.id === id) ?? null;
}

export function bumpCounter(
  session: ClinicalSession,
  key: keyof ClinicalSession['counters'],
): ClinicalSession {
  return { ...session, counters: { ...session.counters, [key]: session.counters[key] + 1 } };
}

export function utteranceLatency(input: UtteranceInput): number {
  return Math.max(0, Math.round(input.timing.observedAt - input.timing.startedAt));
}

export function latencySummary(samples: readonly number[]): {
  latest: number | null;
  average: number | null;
  p95: number | null;
} {
  if (samples.length === 0) return { latest: null, average: null, p95: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const average = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return { latest: samples[samples.length - 1], average, p95: sorted[p95Index] };
}

export function percentile(samples: readonly number[], fraction: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}
