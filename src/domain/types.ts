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
  kind: ClinicalEventKind;
  transcript: string;
  message: string;
  occurredAt: number;
  latencyMs: number | null;
  /** Stage-by-stage explanation of how this utterance was handled. */
  trace: StageTrace[];
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

/** Everything the intelligence layer is allowed to see about one final result. */
export interface UtteranceInput {
  transcript: string;
  words: AsrWord[];
  timing: TranscriptTiming;
  source: UtteranceSource;
  utteranceId: number | null;
  audioMs: number | null;
  decodeMs: number | null;
  /** Context version observed when this utterance started, for stale rejection. */
  observedVersion: number | null;
  speaker: SpeakerVerdict | null;
  /** Competing readings, best first. Consulted only when the best yields nothing. */
  alternatives?: RecognitionAlternative[];
  overrides?: PipelineOverrides;
}

/* ------------------------------------------------------------------ */
/* Stage vocabulary                                                   */
/* ------------------------------------------------------------------ */

export type StageName =
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
  | 'sequence_mismatch';

export interface PendingConfirmation {
  id: number;
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

export interface JournalEntry {
  id: number;
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
