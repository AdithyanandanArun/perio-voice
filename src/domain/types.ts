export type Surface = 'buccal' | 'lingual';
export type MeasurementType = 'probing_depth';
export type BuccalSite = 'MB' | 'B' | 'DB';
export type LingualSite = 'ML' | 'L' | 'DL';
export type PerioSite = BuccalSite | LingualSite;

export interface ClinicalContext {
  tooth: number;
  surface: Surface;
  measurement: MeasurementType;
  expectedValues: 3;
  position: number;
}

export interface PerioRecord {
  tooth: number;
  surface: Surface;
  probingDepths: [number | null, number | null, number | null];
  bleeding: boolean | null;
  updatedAt: number | null;
}

export type ClinicalEventKind =
  | 'depth_sequence'
  | 'bleeding'
  | 'correction'
  | 'sequence_replacement'
  | 'context'
  | 'ignored'
  | 'rejected';

export interface ClinicalEvent {
  id: number;
  kind: ClinicalEventKind;
  transcript: string;
  message: string;
  occurredAt: number;
  latencyMs: number | null;
}

export interface ClinicalSession {
  context: ClinicalContext;
  charts: Record<string, PerioRecord>;
  history: ClinicalEvent[];
  latencySamples: number[];
  nextEventId: number;
}

export interface TranscriptTiming {
  startedAt: number;
  observedAt: number;
}

export interface ContextPatch {
  tooth?: number;
  surface?: Surface;
}

export const SURFACE_SITES: Record<Surface, readonly [PerioSite, PerioSite, PerioSite]> = {
  buccal: ['MB', 'B', 'DB'],
  lingual: ['ML', 'L', 'DL'],
};
