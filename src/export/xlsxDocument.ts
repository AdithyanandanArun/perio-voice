/**
 * Turns the pure rows from `perioRows.ts` into `write-excel-file` sheet data
 * (plain arrays of cells). Still no I/O — no browser, no file, no dynamic
 * import — so this stays as unit-testable as the row builder itself. The
 * actual file write lives in `downloadPerioChart.ts`.
 */

import type { ExamMeta, PerioChartRow } from './perioRows';
import { APP_VERSION, CHART_SITES, isoDate } from './perioRows';

export type SheetCell = string | number | boolean | null;
export type SheetRow = SheetCell[];

export const PERIO_SHEET_NAME = 'Perio chart';
export const EXAM_SHEET_NAME = 'Exam';

export const PERIO_CHART_HEADER: readonly string[] = [
  'Tooth',
  ...CHART_SITES.map((site) => `PD ${site}`),
  ...CHART_SITES.map((site) => `Rec ${site}`),
  ...CHART_SITES.map((site) => `CAL ${site}`),
  'Bleeding',
  'Suppuration',
  'Plaque',
  'Calculus',
  'Mobility',
  'Furcation',
  'Status',
];

function rowToCells(row: PerioChartRow): SheetRow {
  return [
    row.tooth,
    ...CHART_SITES.map((site) => row.pd[site]),
    ...CHART_SITES.map((site) => row.recession[site]),
    ...CHART_SITES.map((site) => row.cal[site]),
    row.bleeding === '' ? null : row.bleeding,
    row.suppuration === '' ? null : row.suppuration,
    row.plaque === '' ? null : row.plaque,
    row.calculus === '' ? null : row.calculus,
    row.mobility,
    row.furcation,
    row.status,
  ];
}

/** Sheet data for "Perio chart": one header row, then one row per tooth. */
export function buildPerioChartSheetData(rows: readonly PerioChartRow[]): SheetRow[] {
  return [[...PERIO_CHART_HEADER], ...rows.map(rowToCells)];
}

export const EXAM_SHEET_HEADER: readonly string[] = ['Field', 'Value'];

/** Sheet data for "Exam": exam date/time, clinician (if known), app version. */
export function buildExamSheetData(meta: ExamMeta): SheetRow[] {
  return [
    [...EXAM_SHEET_HEADER],
    ['Exam date', isoDate(meta.examDate)],
    ['Exam time', meta.examDate.toTimeString().slice(0, 8)],
    ['Clinician', meta.clinicianName ?? null],
    ['App version', meta.appVersion ?? APP_VERSION],
  ];
}
