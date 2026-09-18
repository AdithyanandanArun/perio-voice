/**
 * Domain vocabulary for the clinical voice intelligence layer.
 *
 * Nothing in this module knows how speech was produced. Recognition supplies
 * transcripts, word timings and an optional speaker verdict; everything below
 * that boundary is deterministic clinical structure.
 */

export type Surface = 'buccal' | 'lingual';
export type BuccalSite = 'MB' | 'B' | 'DB';
export type LingualSite = 'ML' | 'L' | 'DL';
export type PerioSite = BuccalSite | LingualSite;

export type MeasurementType = 'probing_depth' | 'recession';

/** Findings that are recorded as a present/absent assertion for a station. */
export type BinaryFindingType = 'bleeding' | 'suppuration' | 'plaque' | 'calculus';

/** Findings that carry an ordinal grade for the whole tooth. */
export type GradedFindingType = 'mobility' | 'furcation';

export type FindingType = BinaryFindingType | GradedFindingType;

export const BINARY_FINDINGS: readonly BinaryFindingType[] = [
  'bleeding',
  'suppuration',
  'plaque',
  'calculus',
];

export const GRADED_FINDINGS: readonly GradedFindingType[] = ['mobility', 'furcation'];

export const SURFACE_SITES: Record<Surface, readonly [PerioSite, PerioSite, PerioSite]> = {
  buccal: ['MB', 'B', 'DB'],
  lingual: ['ML', 'L', 'DL'],
};

export const SITES_PER_STATION = 3;
export const MIN_TOOTH = 1;
export const MAX_TOOTH = 32;
export const MIN_DEPTH_MM = 1;
export const MAX_DEPTH_MM = 12;
export const MIN_RECESSION_MM = 0;
export const MAX_RECESSION_MM = 12;
export const MAX_MOBILITY_GRADE = 3;
export const MAX_FURCATION_GRADE = 3;

export type Triple<T> = [T, T, T];
export type DepthTriple = Triple<number | null>;

/**
 * Where the clinician currently is. `version` changes only when the anatomical
 * location changes, so a final that was spoken against an older location can be
 * rejected instead of landing in a newer one. Advancing through the three sites
 * of one station is an ordinary consequence of charting and does not bump it.
 */
export interface ClinicalContext {
  tooth: number;
  surface: Surface;
  measurement: MeasurementType;
  expectedValues: number;
  position: number;
  version: number;
}

export interface PerioRecord {
  tooth: number;
  surface: Surface;
  probingDepths: DepthTriple;
  recession: DepthTriple;
  bleeding: boolean | null;
  suppuration: boolean | null;
  plaque: boolean | null;
  calculus: boolean | null;
  updatedAt: number | null;
}

/** Tooth-level findings that are not specific to one surface. */
export interface ToothRecord {
  tooth: number;
  mobility: number | null;
  furcation: number | null;
  missing: boolean;
  updatedAt: number | null;
}

export type ClinicalEventKind =
  | 'depth_sequence'
  | 'recession_sequence'
  | 'bleeding'
  | 'finding'
  | 'correction'
  | 'sequence_replacement'
  | 'context'
  | 'undo'
  | 'redo'
  | 'confirmation'
  | 'ignored'
  | 'rejected';

export interface ClinicalEvent {
  id: number;
  transaction: TransactionIdentity | null;
  transactionId: string | null;
  streamId: string | null;
  utteranceId: number | string | null;
  revision: number;
  observedVersion: number | null;
  originalContextVersion: number | null;
  lifecycle: TransactionLifecycle;
  decision: TransactionDecision;
  kind: ClinicalEventKind;
  transcript: string;
  message: string;
  occurredAt: number;
  latencyMs: number | null;
  /** Stage-by-stage explanation of how this utterance was handled. */
  trace: StageTrace[];
  /**
   * Ephemeral fast-path result. A non-null value replaces the UI overlay for
   * this transaction; null clears/settles it. Durable chart and journal state
   * intentionally remain separate.
   */
  projection: ClinicalEventProjection | null;
  projectionAction: ProjectionAction;
  journalEntryId: number | null;
}

export interface TranscriptTiming {
  startedAt: number;
  observedAt: number;
}

export interface ContextPatch {
  tooth?: number;
  surface?: Surface;
  measurement?: MeasurementType;
}

/* ------------------------------------------------------------------ */
/* Recognition boundary                                               */
/* ------------------------------------------------------------------ */

export interface AsrWord {
  word: string;
  startMs: number;
  endMs: number;
  probability: number;
}

export type SpeakerDecision = 'clinician' | 'other' | 'unknown';

export interface SpeakerVerdict {
  decision: SpeakerDecision;
  similarity: number;
  /** True when the operator has explicitly overridden automatic attribution. */
  overridden: boolean;
}

export type UtteranceSource = 'asr' | 'simulator' | 'evaluation';

/**
 * A competing reading of the same audio.
 *
 * Short clinical words are often genuinely ambiguous to a recognizer — "two" and
 * "tooth" differ by one weak fricative, and the acoustic model returns both at
 * identical confidence. The clinical context knows which one is possible, so the
 * pipeline re-reads an utterance through its alternatives rather than accepting
 * an arbitrary tie-break.
 */
export interface RecognitionAlternative {
  text: string;
  confidence: number;
}

/**
 * Stage-by-stage approvals carried by a replayed utterance.
 *
 * When a stage holds an utterance it keeps the original input; approving the
 * confirmation replays that exact input with the approval attached, so the
 * operator's decision is recorded as a normal pipeline pass rather than a
 * side-channel write into the chart.
 */
export interface PipelineOverrides {
  speaker?: boolean;
  relevance?: boolean;
  polarity?: boolean;
  overwrite?: boolean;
  correction?: boolean;
}

/**
 * Lifecycle for a recognition transaction. Provisional and held values are
 * projection-only states; only confirmed/corrected values reach durable state.
 */
export type TransactionLifecycle = 'provisional' | 'confirmed' | 'corrected' | 'held';

export type TransactionDecision = 'committed' | 'held' | 'rejected' | 'ignored';

/** Stable identity carried across recognition, projection and confirmation. */
export interface TransactionIdentity {
  transactionId: string;
  streamId: string | null;
  utteranceId: number | string | null;
  revision: number;
  /** Context version observed when recognition began. */
  observedVersion: number | null;
  /** Explicit alias for clients that call the field an original version. */
  originalContextVersion: number | null;
}

/** Bounded idempotency record retained by the in-memory clinical session. */
export interface TransactionRecord {
  identity: TransactionIdentity;
  payloadHash: string;
  lifecycle: TransactionLifecycle;
  decision: TransactionDecision;
  eventId: number | null;
  journalEntryId: number | null;
  updatedAt: number;
}

/** Everything the intelligence layer is allowed to see about one final result. */
export interface UtteranceInput {
  transcript: string;
  words: AsrWord[];
  timing: TranscriptTiming;
  source: UtteranceSource;
  utteranceId: number | string | null;
  audioMs: number | null;
  decodeMs: number | null;
  /** Context version observed when this utterance started, for stale rejection. */
  observedVersion: number | null;
  /** Optional stream identity from the recognition transport. */
  streamId?: string | null;
  /** Stable transaction identity; absent for legacy simulator inputs. */
  transactionId?: string | null;
  /** Monotonic producer revision within a transaction identity. */
  revision?: number;
  /** Additive alias for clients using this terminology. */
  originalContextVersion?: number | null;
  /** Optional producer lifecycle; durable processing derives its own outcome. */
  lifecycle?: TransactionLifecycle;
  speaker: SpeakerVerdict | null;
  /** Competing readings, best first. Consulted only when the best yields nothing. */
  alternatives?: RecognitionAlternative[];
  /**
   * Enables the strict all-or-nothing parser used only for deliberately
   * delimiter-separated automatic-chart batches. Normal spoken charting keeps
   * its established conversational grammar and confirmation behaviour.
   */
  strictAutoChart?: boolean;
  /** Internal replay marker used when a held transaction is approved. */
  replayOfTransaction?: boolean;
  overrides?: PipelineOverrides;
}

/* ------------------------------------------------------------------ */
/* Stage vocabulary                                                   */
/* ------------------------------------------------------------------ */

export type StageName =
  | 'auto_chart'
  | 'speaker'
  | 'staleness'
  | 'lexicon'
  | 'lattice'
  | 'context'
  | 'relevance'
  | 'grammar'
  | 'negation'
  | 'correction'
  | 'sequence'
  | 'commit';

export type StageOutcome = 'pass' | 'block' | 'confirm' | 'adjust' | 'reject';

export interface StageTrace {
  stage: StageName;
  outcome: StageOutcome;
  detail: string;
  durationMs: number;
}

export type ConfirmationReason =
  | 'uncertain_relevance'
  | 'ambiguous_correction'
  | 'low_confidence_polarity'
  | 'unknown_speaker'
  | 'sequence_mismatch'
  | 'missing_grade'
  // Keep confirmation consumers source-compatible with additive reasons from
  // later leaves while retaining the canonical reasons above for the domain.
  | `${string}`;

export interface PendingConfirmation {
  id: number;
  transaction?: TransactionIdentity | null;
  /** False for clarification holds that require a repeat rather than approval. */
  approvable?: boolean;
  /** Explicitly tells the UI that the held phrase must be repeated. */
  repeatRequired?: boolean;
  reason: ConfirmationReason;
  transcript: string;
  message: string;
  createdAt: number;
  /** Replaying this input after operator approval is what commits the value. */
  input: UtteranceInput;
}

/* ------------------------------------------------------------------ */
/* Journal                                                            */
/* ------------------------------------------------------------------ */

export type ChartField =
  | 'probingDepths'
  | 'recession'
  | 'bleeding'
  | 'suppuration'
  | 'plaque'
  | 'calculus'
  | 'mobility'
  | 'furcation'
  | 'missing';

export interface ChartChange {
  tooth: number;
  surface: Surface | null;
  field: ChartField;
  siteIndex: number | null;
  before: number | boolean | null;
  after: number | boolean | null;
}

/** How a clinical event reconciles the projected fast-path overlay. */
export type ProjectionAction = 'replace' | 'confirm' | 'clear' | 'none';

/**
 * Event-local projection for a provisional recognition result. `changes` are
 * the requested chart changes and `context`/`workflow` are the post-parse
 * shadow state the UI may render immediately. None of these values are
 * durable until a later confirmed event is accepted.
 */
export interface ClinicalEventProjection {
  transaction: TransactionIdentity;
  changes: ChartChange[];
  context: ClinicalContext;
  workflow: WorkflowState;
}

/**
 * Ephemeral projection contract for the fast path. These values are never
 * stored in `ClinicalSession.charts` or `ClinicalSession.journal`; a later UI
 * may render them over confirmed state and drop them on rejection.
 */
export interface ProjectedChartChange extends ChartChange {
  transaction: TransactionIdentity;
  lifecycle: TransactionLifecycle;
}

export interface ProjectedTransaction {
  identity: TransactionIdentity;
  lifecycle: TransactionLifecycle;
  decision: TransactionDecision;
  changes: ProjectedChartChange[];
}

export interface ProjectedOverlay {
  revision: number;
  generatedAt: number;
  transactions: ProjectedTransaction[];
}

export interface JournalEntry {
  id: number;
  /** Null for legacy/button writes; set for recognized transactions. */
  transactionId: string | null;
  streamId: string | null;
  utteranceId: number | string | null;
  revision: number;
  observedVersion: number | null;
  originalContextVersion: number | null;
  /** Durable journal entries are confirmed, or corrected confirmed writes. */
  lifecycle: 'confirmed' | 'corrected';
  transcript: string;
  kind: ClinicalEventKind;
  changes: ChartChange[];
  occurredAt: number;
  /** Set when a later correction replaced the values this entry wrote. */
  supersededBy: number | null;
  /** Set when this entry exists only to reverse another entry. */
  compensates: number | null;
  undone: boolean;
}

/* ------------------------------------------------------------------ */
/* Session                                                            */
/* ------------------------------------------------------------------ */

export interface RelevanceCounters {
  chartable: number;
  nonChartable: number;
  uncertain: number;
  blockedSpeaker: number;
  staleContext: number;
}

export interface SessionSettings {
  /**
   * Move to the next station automatically when one completes. Off by default:
   * continuous traversal is powerful during a full-mouth pass but surprising
   * when the clinician is working a single site.
   */
  autoAdvance: boolean;
  /**
   * `shadow` records relevance decisions without letting them block a commit,
   * which is how a classifier change is evaluated before it can affect a chart.
   */
  relevanceMode: 'enforce' | 'shadow';
  /** Require a verified clinician voice before any utterance can commit. */
  requireSpeaker: boolean;
}

export interface ClinicalSession {
  settings: SessionSettings;
  context: ClinicalContext;
  workflow: WorkflowState;
  charts: Record<string, PerioRecord>;
  teeth: Record<number, ToothRecord>;
  history: ClinicalEvent[];
  journal: JournalEntry[];
  pending: PendingConfirmation[];
  latencySamples: number[];
  parserSamples: number[];
  counters: RelevanceCounters;
  nextEventId: number;
  nextJournalId: number;
  nextConfirmationId: number;
  /** Bounded transaction identity/payload registry for idempotent finals. */
  transactions: Record<string, TransactionRecord>;
  /** Insertion order for deterministic bounded eviction. */
  transactionOrder: string[];
}

/* ------------------------------------------------------------------ */
/* Workflow                                                           */
/* ------------------------------------------------------------------ */

export interface Station {
  tooth: number;
  surface: Surface;
}

export type WorkflowMode = 'sequential' | 'manual';

export interface WorkflowState {
  /** Index into the configured station order. */
  stationIndex: number;
  mode: WorkflowMode;
  skipped: number[];
  /** Station indices the clinician left before finishing, newest last. */
  resumeStack: number[];
}
