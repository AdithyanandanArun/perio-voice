/**
 * Public surface of the clinical domain.
 *
 * The evaluation harness runs the real pipeline rather than a reimplementation
 * of it, so this barrel is what it bundles. Exports are explicit because several
 * modules deliberately share names.
 */

export type {
  AsrWord,
  ChartChange,
  ClinicalContext,
  ClinicalEvent,
  ClinicalEventKind,
  ClinicalEventProjection,
  ClinicalSession,
  ConfirmationReason,
  DepthTriple,
  FindingType,
  JournalEntry,
  MeasurementType,
  PendingConfirmation,
  PerioRecord,
  ProjectionAction,
  ProjectedChartChange,
  ProjectedOverlay,
  ProjectedTransaction,
  SessionSettings,
  SpeakerVerdict,
  StageName,
  StageTrace,
  Surface,
  TransactionDecision,
  TransactionIdentity,
  TransactionLifecycle,
  TransactionRecord,
  ToothRecord,
  UtteranceInput,
  WorkflowState,
} from './types';

export type { TransactionCheck } from './session';

export { BINARY_FINDINGS, GRADED_FINDINGS, SITES_PER_STATION, SURFACE_SITES } from './types';

export {
  chartKey,
  emptyRecord,
  emptyTooth,
  filledCount,
  isStationComplete,
  lastFilledPosition,
  measurementValues,
  nextOpenPosition,
  recordAt,
  siteName,
  toothAt,
  touchedRecords,
} from './chart';

export { LEXICON_VERSION, canonicalize, dentalPrompt, promptVersion } from './lexicon';
export { buildLattice } from './lattice';
export { resolveWithContext } from './contextResolver';
export { classifyRelevance, explainRelevance } from './relevance';
export { parseIntents } from './grammar';
export { resolveAssertions } from './negation';
export { alignmentError } from './sequenceGuard';
export { measurementEntries, redoableEntry, undoableEntry } from './journal';
export {
  QUADRANT_LABELS,
  STATION_COUNT,
  STATION_ORDER,
  quadrantOf,
  stationAt,
  stationIndexOf,
  workflowProgress,
} from './workflow';
export { createInitialSession, latencySummary, percentile } from './session';
export {
  inspectTransaction,
  MAX_TRANSACTIONS,
  observedVersionOf,
  rememberTransaction,
  transactionIdentityForInput,
  transactionKey,
  transactionPayloadHash,
} from './session';
export { processUtterance } from './pipeline';
export { processAutoChart, splitAutoChartClauses } from './autoChart';
export {
  applyTranscript,
  clearCurrentRecord,
  currentRecord,
  simulatorInput,
  updateContext,
} from './clinicalEngine';
