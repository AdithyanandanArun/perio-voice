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
  TransactionDecision,
  ClinicalEventProjection,
  TransactionIdentity,
  TransactionLifecycle,
  TransactionRecord,
  ProjectionAction,
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
export const MAX_TRANSACTIONS = 256;

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
    transactions: {},
    transactionOrder: [],
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
  transaction?: TransactionIdentity | null;
  lifecycle?: TransactionLifecycle;
  decision?: TransactionDecision;
  projection?: ClinicalEventProjection | null;
  projectionAction?: ProjectionAction;
}

export interface TransactionCheck {
  state: 'new' | 'duplicate' | 'conflict' | 'replay' | 'revision';
  identity: TransactionIdentity | null;
  key: string | null;
  payloadHash: string | null;
  previous: TransactionRecord | null;
}

/** The observed version accepted by both legacy and additive transport inputs. */
export function observedVersionOf(input: UtteranceInput): number | null {
  return input.observedVersion ?? input.originalContextVersion ?? null;
}

function explicitTransactionId(input: UtteranceInput): string | null {
  const value = input.transactionId?.trim();
  if (value) return value;
  const streamId = input.streamId?.trim();
  if (streamId && input.utteranceId !== null && input.utteranceId !== undefined) {
    return `${streamId}:${String(input.utteranceId)}`;
  }
  return null;
}

/** Creates a stable identity only when the recognition boundary supplied one. */
export function transactionIdentityForInput(
  input: UtteranceInput,
  _currentVersion: number,
): TransactionIdentity | null {
  const transactionId = explicitTransactionId(input);
  if (transactionId === null) return null;
  // A transaction's context is part of the recognition contract. Do not bind
  // a missing ASR observation to whatever cursor happens to be current when a
  // final arrives; the pipeline will fail that input closed. Legacy simulator
  // and evaluation callers may still omit the version and retain their old
  // behaviour because they do not cross an ASR recognition boundary.
  const observedVersion = observedVersionOf(input);
  const revision = Number.isInteger(input.revision) && (input.revision as number) >= 0
    ? input.revision as number
    : 0;
  return {
    transactionId,
    streamId: input.streamId?.trim() || null,
    utteranceId: input.utteranceId ?? null,
    revision,
    observedVersion,
    originalContextVersion: observedVersion,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

/**
 * Fingerprints the clinical payload, excluding timing and approval metadata.
 * Approval may replay the same payload at a later wall-clock time without
 * turning it into a conflicting transaction.
 */
export function transactionPayloadHash(input: UtteranceInput): string {
  const payload = {
    transcript: input.transcript,
    words: input.words,
    source: input.source,
    utteranceId: input.utteranceId,
    streamId: input.streamId ?? null,
    transactionId: input.transactionId ?? null,
    speaker: input.speaker,
    alternatives: input.alternatives ?? [],
    strictAutoChart: input.strictAutoChart ?? false,
  };
  const text = stableJson(payload);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${text.length}`;
}

export function transactionKey(identity: TransactionIdentity | null): string | null {
  return identity === null ? null : identity.transactionId;
}

export function inspectTransaction(
  session: ClinicalSession,
  input: UtteranceInput,
): TransactionCheck {
  const identity = transactionIdentityForInput(input, session.context.version);
  const key = transactionKey(identity);
  if (identity === null || key === null) {
    return { state: 'new', identity: null, key: null, payloadHash: null, previous: null };
  }
  const payloadHash = transactionPayloadHash(input);
  const previous = session.transactions[key] ?? null;
  if (previous === null) {
    return { state: 'new', identity, key, payloadHash, previous: null };
  }
  // A legacy final without a version is still allowed to repeat its exact
  // payload after the cursor moves. An explicitly supplied version remains
  // part of the conflict check; an ASR caller without one is rejected by the
  // pipeline before this result can be applied.
  const sameContext = observedVersionOf(input) === null
    || previous.identity.observedVersion === identity.observedVersion;
  if (
    input.replayOfTransaction === true
    && previous.payloadHash === payloadHash
    && sameContext
    && previous.lifecycle === 'held'
    && identity.revision === previous.identity.revision
  ) {
    return { state: 'replay', identity, key, payloadHash, previous };
  }

  const samePayload = previous.payloadHash === payloadHash && sameContext;
  const revision = identity.revision;
  const previousRevision = previous.identity.revision;
  if (revision <= previousRevision) {
    return {
      state: samePayload ? 'duplicate' : 'conflict',
      identity,
      key,
      payloadHash,
      previous,
    };
  }

  // A producer may publish a more complete revision after a provisional or
  // held result. It is the same transaction, so the later revision may finish
  // it once, but a confirmed/corrected transaction is terminal and cannot be
  // rewritten by a new clinical payload.
  if (previous.lifecycle === 'provisional' || previous.lifecycle === 'held') {
    return { state: 'revision', identity, key, payloadHash, previous };
  }
  if (samePayload || previous.lifecycle === 'confirmed' || previous.lifecycle === 'corrected') {
    return {
      state: samePayload ? 'duplicate' : 'conflict',
      identity,
      key,
      payloadHash,
      previous,
    };
  }
  return { state: 'conflict', identity, key, payloadHash, previous };
}

/** Removes only the pending projection owned by a transaction revision. */
export function removePendingForTransaction(
  session: ClinicalSession,
  transactionId: string,
): ClinicalSession {
  const pending = session.pending.filter(
    (candidate) => candidate.transaction?.transactionId !== transactionId,
  );
  return pending.length === session.pending.length ? session : { ...session, pending };
}

/** Records one bounded identity decision, evicting the oldest key if needed. */
export function rememberTransaction(
  session: ClinicalSession,
  input: UtteranceInput,
  decision: TransactionDecision,
  lifecycle: TransactionLifecycle,
  eventId: number | null,
  journalEntryId: number | null,
  at: number,
  identityOverride: TransactionIdentity | null = null,
): ClinicalSession {
  // A transaction may move context while its shadow intents are applied. The
  // identity must remain anchored to the version observed at the start, not to
  // the cursor after the commit.
  const identity = identityOverride ?? transactionIdentityForInput(input, session.context.version);
  const key = transactionKey(identity);
  if (identity === null || key === null) return session;
  const transactions = { ...(session.transactions ?? {}) };
  transactions[key] = {
    identity,
    payloadHash: transactionPayloadHash(input),
    lifecycle,
    decision,
    eventId,
    journalEntryId,
    updatedAt: at,
  };
  const order = (session.transactionOrder ?? []).filter((candidate) => candidate !== key);
  order.push(key);
  while (order.length > MAX_TRANSACTIONS) {
    const evicted = order.shift();
    if (evicted !== undefined) delete transactions[evicted];
  }
  return { ...session, transactions, transactionOrder: order };
}

/**
 * Appends one audit event and, when the utterance wrote something, the journal
 * entry that records exactly what changed.
 */
export function recordEvent(session: ClinicalSession, draft: EventDraft): ClinicalSession {
  const requestedChanges = draft.changes ?? [];
  const lifecycle = draft.lifecycle
    ?? (draft.kind === 'correction'
      ? 'corrected'
      : draft.kind === 'confirmation' || draft.kind === 'rejected' || draft.kind === 'ignored'
        ? 'held'
        : 'confirmed');
  // Held/provisional outcomes are projection-only. Even if a caller hands the
  // event writer a tentative change list, it must not become durable journal
  // state; the chart mutation remains owned by the confirmed shadow commit.
  const changes = lifecycle === 'provisional' || lifecycle === 'held' ? [] : requestedChanges;
  const writesJournal = lifecycle !== 'provisional'
    && lifecycle !== 'held'
    && (changes.length > 0 || draft.compensates !== undefined);
  const journalId = writesJournal ? session.nextJournalId : null;
  const decision = draft.decision
    ?? (draft.kind === 'confirmation' ? 'held' : draft.kind === 'rejected' ? 'rejected' : draft.kind === 'ignored' ? 'ignored' : 'committed');
  const transaction = draft.transaction ?? null;
  const projection = lifecycle === 'provisional' && draft.projection !== undefined
    ? draft.projection
    : null;
  const projectionAction = draft.projectionAction
    ?? (transaction === null
      ? 'none'
      : projection !== null
        ? 'replace'
        : lifecycle === 'confirmed' || lifecycle === 'corrected'
          ? 'confirm'
          : 'clear');

  let journal = session.journal;
  if (writesJournal) {
    const entry: JournalEntry = {
      id: session.nextJournalId,
      transactionId: draft.transaction?.transactionId ?? null,
      streamId: draft.transaction?.streamId ?? null,
      utteranceId: draft.transaction?.utteranceId ?? null,
      revision: draft.transaction?.revision ?? 0,
      observedVersion: draft.transaction?.observedVersion ?? null,
      originalContextVersion: draft.transaction?.originalContextVersion ?? null,
      lifecycle: lifecycle === 'corrected' ? 'corrected' : 'confirmed',
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
    transaction,
    transactionId: transaction?.transactionId ?? null,
    streamId: transaction?.streamId ?? null,
    utteranceId: transaction?.utteranceId ?? null,
    revision: transaction?.revision ?? 0,
    observedVersion: transaction?.observedVersion ?? null,
    originalContextVersion: transaction?.originalContextVersion ?? null,
    lifecycle,
    decision,
    kind: draft.kind,
    transcript: draft.transcript,
    message: draft.message,
    occurredAt: draft.occurredAt,
    latencyMs: draft.latencyMs,
    trace: draft.trace,
    projection,
    projectionAction,
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
  const identity = confirmation.transaction
    ?? transactionIdentityForInput(confirmation.input, session.context.version);
  const observedVersion = observedVersionOf(confirmation.input) ?? session.context.version;
  const input: UtteranceInput = {
    ...confirmation.input,
    observedVersion,
    originalContextVersion: observedVersion,
  };
  return {
    ...session,
    pending: [...session.pending, { ...confirmation, input, transaction: identity, id: session.nextConfirmationId }],
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
