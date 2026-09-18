/**
 * Pure row-building for the clinical Excel export (gate G58).
 *
 * Nothing here touches the DOM or a file. It reads the same `ClinicalSession`
 * the rest of the app reads and produces plain data: one row per tooth,
 * 1..32, in the fixed clinical order a periodontal chart is normally read in.
 * File writing (the xlsx library, the download) lives in `xlsxDocument.ts` /
 * `downloadPerioChart.ts` so this module stays trivially unit-testable.
 */

import { recordAt, toothAt } from '../domain/chart';
import { MAX_TOOTH, MIN_TOOTH, SURFACE_SITES, type ClinicalSession, type PerioRecord } from '../domain/types';

/**
 * The six-site clinical charting order, walking continuously around the
 * tooth: buccal mesial -> buccal centre -> buccal distal -> lingual distal ->
 * lingual centre -> lingual mesial.
 *
 * This app's domain model stores each surface's triple in traversal order —
 * `SURFACE_SITES.buccal = ['MB', 'B', 'DB']` and
 * `SURFACE_SITES.lingual = ['ML', 'L', 'DL']` (see `src/domain/types.ts`) — so
 * the buccal columns read the stored triple forwards, and the lingual columns
 * read it *backwards* (DL, L, ML) to continue the same loop around the tooth
 * instead of jumping back to the mesial line angle.
 */
export const CHART_SITES = ['MB', 'B', 'DB', 'DL', 'L', 'ML'] as const;
export type ChartSite = (typeof CHART_SITES)[number];

const SITE_SURFACE: Record<ChartSite, 'buccal' | 'lingual'> = {
  MB: 'buccal',
  B: 'buccal',
  DB: 'buccal',
  DL: 'lingual',
  L: 'lingual',
  ML: 'lingual',
};

function siteIndex(site: ChartSite): number {
  const surface = SITE_SURFACE[site];
  return SURFACE_SITES[surface].indexOf(site);
}

export type PerioChartStatus = 'charted' | 'not charted' | 'skipped';

export interface PerioChartRow {
  tooth: number;
  pd: Record<ChartSite, number | null>;
  recession: Record<ChartSite, number | null>;
  /** CAL = probing depth + recession, per site. Blank unless BOTH inputs exist. */
  cal: Record<ChartSite, number | null>;
  /**
   * `bleeding`/`suppuration`/`plaque`/`calculus` are recorded per *surface* in
   * this domain model (`PerioRecord.bleeding` etc.), not per individual site —
   * there is no finer-grained source value to report. Rather than fabricate
   * per-site detail, each column lists which surface(s) are positive, using
   * that surface's single-letter site code ("B" for buccal, "L" for lingual),
   * comma-separated when both are positive. Blank means neither surface was
   * positive (recorded false, or not yet recorded — this app does not
   * distinguish the two for these findings).
   */
  bleeding: string;
  suppuration: string;
  plaque: string;
  calculus: string;
  mobility: number | null;
  furcation: number | null;
  status: PerioChartStatus;
}

function siteValues(
  buccal: PerioRecord,
  lingual: PerioRecord,
  field: 'probingDepths' | 'recession',
): Record<ChartSite, number | null> {
  const result = {} as Record<ChartSite, number | null>;
  for (const site of CHART_SITES) {
    const record = SITE_SURFACE[site] === 'buccal' ? buccal : lingual;
    result[site] = record[field][siteIndex(site)];
  }
  return result;
}

function calValues(
  pd: Record<ChartSite, number | null>,
  recession: Record<ChartSite, number | null>,
): Record<ChartSite, number | null> {
  const result = {} as Record<ChartSite, number | null>;
  for (const site of CHART_SITES) {
    const depth = pd[site];
    const rec = recession[site];
    result[site] = depth === null || rec === null ? null : depth + rec;
  }
  return result;
}

function surfaceFlags(buccal: PerioRecord, lingual: PerioRecord, field: 'bleeding' | 'suppuration' | 'plaque' | 'calculus'): string {
  const labels: string[] = [];
  if (buccal[field] === true) labels.push('B');
  if (lingual[field] === true) labels.push('L');
  return labels.join(', ');
}

function statusOf(buccal: PerioRecord, lingual: PerioRecord, missing: boolean): PerioChartStatus {
  if (missing) return 'skipped';
  const charted = buccal.updatedAt !== null || lingual.updatedAt !== null;
  return charted ? 'charted' : 'not charted';
}

/** One row per tooth, `MIN_TOOTH`..`MAX_TOOTH` in ascending order. */
export function buildPerioChartRows(session: ClinicalSession): PerioChartRow[] {
  const rows: PerioChartRow[] = [];
  for (let tooth = MIN_TOOTH; tooth <= MAX_TOOTH; tooth += 1) {
    const buccal = recordAt(session.charts, tooth, 'buccal');
    const lingual = recordAt(session.charts, tooth, 'lingual');
    const toothRecord = toothAt(session.teeth, tooth);
    const pd = siteValues(buccal, lingual, 'probingDepths');
    const recession = siteValues(buccal, lingual, 'recession');
    rows.push({
      tooth,
      pd,
      recession,
      cal: calValues(pd, recession),
      bleeding: surfaceFlags(buccal, lingual, 'bleeding'),
      suppuration: surfaceFlags(buccal, lingual, 'suppuration'),
      plaque: surfaceFlags(buccal, lingual, 'plaque'),
      calculus: surfaceFlags(buccal, lingual, 'calculus'),
      mobility: toothRecord.mobility,
      furcation: toothRecord.furcation,
      status: statusOf(buccal, lingual, toothRecord.missing),
    });
  }
  return rows;
}

export interface ExamMeta {
  examDate: Date;
  clinicianName: string | null;
  appVersion: string;
}

/** Kept in sync with `package.json`'s `version` field by hand — see README of this module. */
export const APP_VERSION = '0.2.0';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function perioChartFilename(date: Date): string {
  return `perio-chart-${isoDate(date)}.xlsx`;
}

/** Summary counts the graph page's header reads from — same rows, no fresh mapping. */
export interface PerioChartSummary {
  teethCharted: number;
  sitesAtOrAbove4mm: number;
  sitesAtOrAbove6mm: number;
  totalSitesRecorded: number;
  bleedingPercent: number | null;
}

export function summarizePerioChart(rows: readonly PerioChartRow[]): PerioChartSummary {
  let sitesAtOrAbove4mm = 0;
  let sitesAtOrAbove6mm = 0;
  let totalSitesRecorded = 0;
  let bleedingSurfaces = 0;
  let recordedSurfaces = 0;
  for (const row of rows) {
    for (const site of CHART_SITES) {
      const value = row.pd[site];
      if (value === null) continue;
      totalSitesRecorded += 1;
      if (value >= 4) sitesAtOrAbove4mm += 1;
      if (value >= 6) sitesAtOrAbove6mm += 1;
    }
    if (row.status === 'charted') {
      recordedSurfaces += 2; // buccal + lingual — see the `bleeding` field comment above.
      bleedingSurfaces += row.bleeding.split(',').filter((label) => label.trim() !== '').length;
    }
  }
  return {
    teethCharted: rows.filter((row) => row.status === 'charted').length,
    sitesAtOrAbove4mm,
    sitesAtOrAbove6mm,
    totalSitesRecorded,
    bleedingPercent: recordedSurfaces === 0 ? null : Math.round((bleedingSurfaces / recordedSurfaces) * 100),
  };
}
