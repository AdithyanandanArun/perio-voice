import { useId, useMemo } from 'react';
import type { ClinicalSession } from '../domain/types';
import {
  buildPerioChartRows,
  CHART_SITES,
  summarizePerioChart,
  type ChartSite,
  type PerioChartRow,
  type PerioChartSummary,
} from '../export/perioRows';
import './PerioGraphs.css';

/**
 * Reads the exact same per-tooth, per-site rows the Excel export writes
 * (`buildPerioChartRows`), so the graph and the spreadsheet can never disagree
 * about what a site's probing depth is. This component only lays those rows
 * out as an SVG perio chart; it never parses clinical language itself.
 */

const MM_SCALE_PX = 9; // pixels per millimetre of probing depth
const BAR_WIDTH = 7;
const SITE_GAP = 2;
const TOOTH_GAP = 7;
const BAND_HEIGHT = 12 * MM_SCALE_PX; // MAX_DEPTH_MM
const AXIS_HEIGHT = 20;
const BAND_LABEL_WIDTH = 56;

interface Arch {
  label: string;
  teeth: readonly number[];
}

const ARCHES: readonly Arch[] = [
  { label: 'Upper arch (1–16)', teeth: Array.from({ length: 16 }, (_, i) => i + 1) },
  { label: 'Lower arch (17–32)', teeth: Array.from({ length: 16 }, (_, i) => 32 - i) },
];

function depthColor(value: number): string {
  if (value >= 6) return 'var(--danger)';
  if (value >= 4) return 'var(--warning)';
  return 'var(--success)';
}

function toothGroupWidth(): number {
  return 3 * BAR_WIDTH + 2 * SITE_GAP;
}

function archWidth(teethCount: number): number {
  return BAND_LABEL_WIDTH + teethCount * toothGroupWidth() + (teethCount - 1) * TOOTH_GAP;
}

/** One row of six bars (three buccal or three lingual sites) for one tooth. */
function ToothBars({
  row,
  sites,
  x,
  surfaceBled,
}: {
  row: PerioChartRow;
  sites: readonly [ChartSite, ChartSite, ChartSite];
  x: number;
  surfaceBled: boolean;
}) {
  return (
    <g>
      {sites.map((site, index) => {
        const value = row.pd[site];
        const barX = x + index * (BAR_WIDTH + SITE_GAP);
        if (value === null) {
          return (
            <rect
              key={site}
              x={barX}
              y={BAND_HEIGHT - 2}
              width={BAR_WIDTH}
              height={2}
              fill="var(--border)"
            />
          );
        }
        const height = Math.min(value, 12) * MM_SCALE_PX;
        return (
          <rect
            key={site}
            x={barX}
            y={BAND_HEIGHT - height}
            width={BAR_WIDTH}
            height={height}
            fill={depthColor(value)}
            aria-hidden="true"
          />
        );
      })}
      {surfaceBled && (
        <circle
          cx={x + (3 * BAR_WIDTH + 2 * SITE_GAP) / 2}
          cy={-6}
          r={3.5}
          fill="var(--danger)"
          aria-hidden="true"
        />
      )}
    </g>
  );
}

function ReferenceLines({ width }: { width: number }) {
  const y4 = BAND_HEIGHT - 4 * MM_SCALE_PX;
  const y6 = BAND_HEIGHT - 6 * MM_SCALE_PX;
  return (
    <g aria-hidden="true">
      <line x1={0} y1={y4} x2={width} y2={y4} className="graph-reference-line" />
      <text x={width + 4} y={y4 + 3} className="graph-reference-label">4mm</text>
      <line x1={0} y1={y6} x2={width} y2={y6} className="graph-reference-line graph-reference-line-6" />
      <text x={width + 4} y={y6 + 3} className="graph-reference-label">6mm</text>
    </g>
  );
}

function ArchChart({ arch, rows }: { arch: Arch; rows: readonly PerioChartRow[] }) {
  const byTooth = useMemo(() => {
    const map = new Map<number, PerioChartRow>();
    for (const row of rows) map.set(row.tooth, row);
    return map;
  }, [rows]);
  const bandWidth = arch.teeth.length * toothGroupWidth() + (arch.teeth.length - 1) * TOOTH_GAP;
  const totalWidth = archWidth(arch.teeth.length) + 32;
  const totalHeight = BAND_HEIGHT * 2 + AXIS_HEIGHT + 24;

  return (
    <div className="perio-graph-arch">
      <h3>{arch.label}</h3>
      <svg
        viewBox={`0 0 ${totalWidth} ${totalHeight}`}
        role="img"
        aria-label={`${arch.label} probing depth chart, buccal above, lingual below, teeth ${arch.teeth[0]} to ${arch.teeth[arch.teeth.length - 1]}`}
        className="perio-graph-svg"
      >
        <g transform="translate(0, 12)">
          <text x={0} y={-2} className="graph-band-label">Buccal</text>
          <g transform={`translate(${BAND_LABEL_WIDTH}, 0)`}>
            <ReferenceLines width={bandWidth} />
            {arch.teeth.map((tooth, index) => {
              const row = byTooth.get(tooth);
              if (!row) return null;
              const x = index * (toothGroupWidth() + TOOTH_GAP);
              return (
                <ToothBars key={tooth} row={row} sites={['MB', 'B', 'DB']} x={x} surfaceBled={row.bleeding.includes('B')} />
              );
            })}
          </g>
        </g>
        <g transform={`translate(0, ${BAND_HEIGHT + 12})`}>
          {arch.teeth.map((tooth, index) => {
            const x = BAND_LABEL_WIDTH + index * (toothGroupWidth() + TOOTH_GAP) + toothGroupWidth() / 2;
            return (
              <text key={tooth} x={x} y={14} textAnchor="middle" className="graph-tooth-label">
                {tooth}
              </text>
            );
          })}
        </g>
        <g transform={`translate(0, ${BAND_HEIGHT + AXIS_HEIGHT + 24})`}>
          <text x={0} y={-2} className="graph-band-label">Lingual</text>
          <g transform={`translate(${BAND_LABEL_WIDTH}, 0)`}>
            <ReferenceLines width={bandWidth} />
            {arch.teeth.map((tooth, index) => {
              const row = byTooth.get(tooth);
              if (!row) return null;
              const x = index * (toothGroupWidth() + TOOTH_GAP);
              return (
                <ToothBars key={tooth} row={row} sites={['DL', 'L', 'ML']} x={x} surfaceBled={row.bleeding.includes('L')} />
              );
            })}
          </g>
        </g>
      </svg>
    </div>
  );
}

function cellText(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** The same rows, as a plain table — the accessible/alternative view of the SVG chart. */
function DataTableFallback({ rows, id }: { rows: readonly PerioChartRow[]; id: string }) {
  const charted = rows.filter((row) => row.status !== 'not charted');
  return (
    <div className="table-wrap perio-graph-table-wrap">
      <table id={id}>
        <caption className="visually-hidden">
          Probing depth, in millimetres, per tooth and site, as an accessible alternative to the chart above
        </caption>
        <thead>
          <tr>
            <th>Tooth</th>
            {CHART_SITES.map((site) => <th key={site}>{site}</th>)}
            <th>Bleeding</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {charted.map((row) => (
            <tr key={row.tooth}>
              <th scope="row">{row.tooth}</th>
              {CHART_SITES.map((site) => <td key={site}>{cellText(row.pd[site])}</td>)}
              <td>{row.bleeding || '—'}</td>
              <td>{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryPanel({ summary }: { summary: PerioChartSummary }) {
  return (
    <dl className="perio-graph-summary" aria-label="Chart summary">
      <div>
        <dt>Teeth charted</dt>
        <dd>{summary.teethCharted} / 32</dd>
      </div>
      <div>
        <dt>Sites ≥ 4mm</dt>
        <dd>{summary.sitesAtOrAbove4mm}</dd>
      </div>
      <div>
        <dt>Sites ≥ 6mm</dt>
        <dd>{summary.sitesAtOrAbove6mm}</dd>
      </div>
      <div>
        <dt>Bleeding</dt>
        <dd>{summary.bleedingPercent === null ? '—' : `${summary.bleedingPercent}%`}</dd>
      </div>
    </dl>
  );
}

export interface PerioGraphsProps {
  session: ClinicalSession;
}

export function PerioGraphs({ session }: PerioGraphsProps) {
  const rows = useMemo(() => buildPerioChartRows(session), [session]);
  const summary = useMemo(() => summarizePerioChart(rows), [rows]);
  const tableId = useId();

  if (summary.teethCharted === 0) {
    return (
      <div className="panel perio-graphs-empty" data-testid="perio-graphs-empty">
        <p>Nothing has been charted yet.</p>
        <p className="perio-graphs-empty-hint">
          Start charting a tooth to see probing depths appear here, per site and per arch.
        </p>
      </div>
    );
  }

  return (
    <div className="perio-graphs" data-testid="perio-graphs">
      <p className="perio-graphs-text-summary">
        {summary.teethCharted} of 32 teeth charted. {summary.sitesAtOrAbove4mm} sites at or above 4mm,{' '}
        {summary.sitesAtOrAbove6mm} at or above 6mm, out of {summary.totalSitesRecorded} recorded sites.{' '}
        {summary.bleedingPercent === null ? 'No bleeding data yet.' : `${summary.bleedingPercent}% of charted surfaces bleeding on probing.`}
      </p>
      <SummaryPanel summary={summary} />
      <div className="perio-graphs-arches">
        {ARCHES.map((arch) => <ArchChart key={arch.label} arch={arch} rows={rows} />)}
      </div>
      <details className="perio-graphs-table-details">
        <summary>Show as data table</summary>
        <DataTableFallback rows={rows} id={tableId} />
      </details>
    </div>
  );
}
