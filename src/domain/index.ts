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
  ClinicalSession,
  ConfirmationReason,
  DepthTriple,
  FindingType,
  JournalEntry,
  MeasurementType,
  PendingConfirmation,
  PerioRecord,
  SessionSettings,
  SpeakerVerdict,
  StageName,
  StageTrace,
  Surface,
  ToothRecord,
  UtteranceInput,
  WorkflowState,
} from './types';

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
export { processUtterance } from './pipeline';
export { processAutoChart, splitAutoChartClauses } from './autoChart';
export {
  applyTranscript,
  clearCurrentRecord,
  currentRecord,
  simulatorInput,
  updateContext,
} from './clinicalEngine';
