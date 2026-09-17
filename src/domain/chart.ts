/** Immutable chart accessors shared by the workflow, guard, and commit stages. */

import {
  SITES_PER_STATION,
  SURFACE_SITES,
  type DepthTriple,
  type MeasurementType,
  type PerioRecord,
  type PerioSite,
  type Surface,
  type ToothRecord,
} from './types';

export function chartKey(tooth: number, surface: Surface): string {
  return `${tooth}-${surface}`;
}

export function emptyRecord(tooth: number, surface: Surface): PerioRecord {
  return {
    tooth,
    surface,
    probingDepths: [null, null, null],
    recession: [null, null, null],
    bleeding: null,
    suppuration: null,
    plaque: null,
    calculus: null,
    updatedAt: null,
  };
}

export function emptyTooth(tooth: number): ToothRecord {
  return { tooth, mobility: null, furcation: null, missing: false, updatedAt: null };
}

export function recordAt(
  charts: Readonly<Record<string, PerioRecord>>,
  tooth: number,
  surface: Surface,
): PerioRecord {
  return charts[chartKey(tooth, surface)] ?? emptyRecord(tooth, surface);
}

export function toothAt(
  teeth: Readonly<Record<number, ToothRecord>>,
  tooth: number,
): ToothRecord {
  return teeth[tooth] ?? emptyTooth(tooth);
}

/** The measurement array a given measurement type writes into. */
export function measurementValues(record: PerioRecord, measurement: MeasurementType): DepthTriple {
  return measurement === 'recession' ? record.recession : record.probingDepths;
}

export function withMeasurement(
  record: PerioRecord,
  measurement: MeasurementType,
  values: DepthTriple,
  updatedAt: number,
): PerioRecord {
  return measurement === 'recession'
    ? { ...record, recession: values, updatedAt }
    : { ...record, probingDepths: values, updatedAt };
}

export function nextOpenPosition(record: PerioRecord, measurement: MeasurementType): number {
  const values = measurementValues(record, measurement);
  const index = values.findIndex((value) => value === null);
  return index === -1 ? SITES_PER_STATION : index;
}

export function lastFilledPosition(record: PerioRecord, measurement: MeasurementType): number {
  const values = measurementValues(record, measurement);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null) return index;
  }
  return -1;
}

export function filledCount(record: PerioRecord, measurement: MeasurementType): number {
  return measurementValues(record, measurement).filter((value) => value !== null).length;
}

export function isStationComplete(record: PerioRecord, measurement: MeasurementType): boolean {
  return filledCount(record, measurement) === SITES_PER_STATION;
}

export function siteName(surface: Surface, index: number): PerioSite {
  return SURFACE_SITES[surface][Math.max(0, Math.min(SITES_PER_STATION - 1, index))];
}

export function ensureRecord(
  charts: Readonly<Record<string, PerioRecord>>,
  tooth: number,
  surface: Surface,
): Record<string, PerioRecord> {
  const key = chartKey(tooth, surface);
  if (charts[key]) return charts as Record<string, PerioRecord>;
  return { ...charts, [key]: emptyRecord(tooth, surface) };
}

export function ensureTooth(
  teeth: Readonly<Record<number, ToothRecord>>,
  tooth: number,
): Record<number, ToothRecord> {
  if (teeth[tooth]) return teeth as Record<number, ToothRecord>;
  return { ...teeth, [tooth]: emptyTooth(tooth) };
}

/** Records the clinician has actually touched, ordered for display. */
export function touchedRecords(
  charts: Readonly<Record<string, PerioRecord>>,
): PerioRecord[] {
  return Object.values(charts)
    .filter((record) => record.updatedAt !== null)
    .sort((a, b) => a.tooth - b.tooth || a.surface.localeCompare(b.surface));
}
