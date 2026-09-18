import { useState } from 'react';
import { ArrowLeft, ArrowRight, Droplet, FlaskConical, X } from 'lucide-react';
import { chartKey } from '../domain/chart';
import { STATION_COUNT, stationIndexOf } from '../domain/workflow';
import type { ClinicalSession, PerioRecord, Surface, ToothRecord } from '../domain/types';
import './ToothChart.css';

/**
 * Pocket-severity bands, taken from one surface's deepest recorded probing
 * depth. One named constant so the thresholds are not scattered across the
 * render.
 */
const POCKET_SEVERITY = {
  HEALTHY_MAX_MM: 3,
  MODERATE_MAX_MM: 5,
} as const;

type PocketSeverity = 'healthy' | 'moderate' | 'severe';

function severityFor(depthMm: number): PocketSeverity {
  if (depthMm <= POCKET_SEVERITY.HEALTHY_MAX_MM) return 'healthy';
  if (depthMm <= POCKET_SEVERITY.MODERATE_MAX_MM) return 'moderate';
  return 'severe';
}

const SEVERITY_LABEL: Record<PocketSeverity, string> = {
  healthy: 'Healthy',
  moderate: 'Moderate',
  severe: 'Severe',
};

const SURFACES: readonly Surface[] = ['buccal', 'lingual'];
const SURFACE_LABEL: Record<Surface, string> = { buccal: 'Buccal', lingual: 'Lingual' };

/** Upper arch, patient's right to left — the conventional chart order. */
const UPPER_ARCH: readonly number[] = Array.from({ length: 16 }, (_, index) => index + 1);
/**
 * Lower arch, drawn right-to-left in the same visual column as the upper arch
 * so tooth 1 sits above tooth 32 and tooth 16 sits above tooth 17, matching a
 * real periodontal chart. Antagonists in the buccal panel line up with the
 * same antagonists in the lingual panel below it.
 */
const LOWER_ARCH: readonly number[] = Array.from({ length: 16 }, (_, index) => 32 - index);

interface SurfaceStatus {
  tooth: number;
  surface: Surface;
  active: boolean;
  missing: boolean;
  charted: boolean;
  deepestDepthMm: number | null;
  severity: PocketSeverity | null;
  bleeding: boolean;
  suppuration: boolean;
  /** 1-based position in the clinician's charting progression, STATION_ORDER. */
  position: number;
}

function deepestOf(record: PerioRecord | undefined): number | null {
  if (record === undefined) return null;
  const values = record.probingDepths.filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return Math.max(...values);
}

function isRecordCharted(record: PerioRecord | undefined): boolean {
  return record !== undefined && record.updatedAt !== null;
}

function statusFor(session: ClinicalSession, tooth: number, surface: Surface): SurfaceStatus {
  const record = session.charts[chartKey(tooth, surface)];
  const toothRecord: ToothRecord | undefined = session.teeth[tooth];
  const missing = toothRecord?.missing === true;
  const deepestDepthMm = deepestOf(record);

  return {
    tooth,
    surface,
    active: session.context.tooth === tooth && session.context.surface === surface,
    missing,
    charted: isRecordCharted(record),
    deepestDepthMm,
    severity: deepestDepthMm !== null ? severityFor(deepestDepthMm) : null,
    bleeding: record?.bleeding === true,
    suppuration: record?.suppuration === true,
    position: stationIndexOf(tooth, surface) + 1,
  };
}

function accessibleName(status: SurfaceStatus): string {
  const label = `Tooth ${status.tooth} ${status.surface}`;
  if (status.missing) return `${label}: missing`;

  const parts: string[] = [];
  parts.push(status.active ? 'active' : 'inactive');
  if (status.charted) {
    parts.push(
      status.deepestDepthMm !== null ? `deepest ${status.deepestDepthMm} mm` : 'charted',
    );
  } else {
    parts.push('not yet charted');
  }
  if (status.bleeding) parts.push('bleeding');
  if (status.suppuration) parts.push('suppuration');
  return `${label}: ${parts.join(', ')}`;
}

/**
 * Which way the clinician's charting progression runs along a displayed row,
 * derived from STATION_ORDER rather than a second hard-coded copy of it. The
 * row is a fixed visual arrangement (`arch`, left to right); the progression
 * direction is whichever way station index increases across it.
 */
function rowDirection(surface: Surface, arch: readonly number[]): 'left' | 'right' {
  const firstIndex = stationIndexOf(arch[0], surface);
  const lastIndex = stationIndexOf(arch[arch.length - 1], surface);
  return lastIndex >= firstIndex ? 'right' : 'left';
}

interface ToothCellProps {
  status: SurfaceStatus;
  selected: boolean;
  onSelect: (tooth: number, surface: Surface) => void;
}

function ToothCell({ status, selected, onSelect }: ToothCellProps) {
  const classes = [
    'tooth-cell',
    status.missing ? 'is-missing' : '',
    status.active ? 'is-active' : '',
    status.severity ? `severity-${status.severity}` : '',
    status.charted ? 'is-charted' : 'is-uncharted',
    selected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      aria-label={accessibleName(status)}
      aria-pressed={selected}
      onClick={() => onSelect(status.tooth, status.surface)}
    >
      <span className="tooth-number" aria-hidden="true">{status.tooth}</span>
      {status.missing ? (
        <span className="tooth-glyph tooth-missing-glyph" aria-hidden="true">
          <X size={14} />
        </span>
      ) : (
        <span className="tooth-glyph" aria-hidden="true">
          {status.severity ? SEVERITY_LABEL[status.severity][0] : '·'}
        </span>
      )}
      <span className="tooth-markers" aria-hidden="true">
        {status.bleeding && <Droplet size={11} className="marker-bleeding" />}
        {status.suppuration && <FlaskConical size={11} className="marker-suppuration" />}
      </span>
    </button>
  );
}

interface ToothChartProps {
  session: ClinicalSession;
}

/**
 * A 64-cell full-mouth status chart, one cell per tooth *surface* (buccal and
 * lingual are charted, tracked and shown separately). Purely a rendering of
 * session state: it never derives clinical meaning beyond a display
 * threshold, and clicking a cell only changes local UI state (which detail
 * card is open), never the chart.
 */
export function ToothChart({ session }: ToothChartProps) {
  const [selected, setSelected] = useState<{ tooth: number; surface: Surface } | null>(null);

  const selectedStatus =
    selected === null ? null : statusFor(session, selected.tooth, selected.surface);

  const continuousChartingOn = session.settings.autoAdvance;

  return (
    <section className="panel tooth-chart-panel" aria-labelledby="tooth-chart-title">
      <div className="panel-heading compact">
        <div>
          <p className="section-index">TOOTH CHART</p>
          <h2 id="tooth-chart-title">Full-mouth status</h2>
        </div>
        <p
          className={`continuous-charting-status ${continuousChartingOn ? 'is-on' : 'is-paused'}`}
        >
          {continuousChartingOn
            ? 'Continuous charting: on'
            : "Continuous charting: paused — say 'start' to resume"}
        </p>
      </div>

      <div className="chart-scroll">
        <div className="tooth-chart-surfaces">
          {SURFACES.map((surface) => {
            const upperDirection = rowDirection(surface, UPPER_ARCH);
            const lowerDirection = rowDirection(surface, LOWER_ARCH);
            return (
              <section
                key={surface}
                className="surface-panel"
                aria-labelledby={`surface-${surface}-title`}
              >
                <h3 id={`surface-${surface}-title`} className="surface-title">
                  {SURFACE_LABEL[surface]}
                </h3>
                <div
                  className="tooth-row"
                  data-direction={upperDirection}
                  aria-label={`${SURFACE_LABEL[surface]} upper arch, teeth 1 to 16`}
                >
                  <span className={`row-direction direction-${upperDirection}`} aria-hidden="true">
                    {upperDirection === 'right' ? <ArrowRight size={12} /> : <ArrowLeft size={12} />}
                  </span>
                  {UPPER_ARCH.map((tooth) => {
                    const status = statusFor(session, tooth, surface);
                    return (
                      <ToothCell
                        key={`${surface}-${tooth}`}
                        status={status}
                        selected={selected?.tooth === tooth && selected?.surface === surface}
                        onSelect={(t, s) => setSelected({ tooth: t, surface: s })}
                      />
                    );
                  })}
                </div>
                <div
                  className="tooth-row"
                  data-direction={lowerDirection}
                  aria-label={`${SURFACE_LABEL[surface]} lower arch, teeth 32 to 17`}
                >
                  <span className={`row-direction direction-${lowerDirection}`} aria-hidden="true">
                    {lowerDirection === 'right' ? <ArrowRight size={12} /> : <ArrowLeft size={12} />}
                  </span>
                  {LOWER_ARCH.map((tooth) => {
                    const status = statusFor(session, tooth, surface);
                    return (
                      <ToothCell
                        key={`${surface}-${tooth}`}
                        status={status}
                        selected={selected?.tooth === tooth && selected?.surface === surface}
                        onSelect={(t, s) => setSelected({ tooth: t, surface: s })}
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {selectedStatus && (
        <div className="tooth-detail" role="status">
          <strong>Tooth {selectedStatus.tooth} {SURFACE_LABEL[selectedStatus.surface]}</strong>
          <span>{accessibleName(selectedStatus)}</span>
          <span className="tooth-detail-position">
            Position {selectedStatus.position} of {STATION_COUNT}
          </span>
        </div>
      )}

      <ul className="tooth-legend" aria-label="Legend">
        <li><span className="legend-swatch severity-healthy" aria-hidden="true">H</span> Healthy (≤{POCKET_SEVERITY.HEALTHY_MAX_MM} mm)</li>
        <li><span className="legend-swatch severity-moderate" aria-hidden="true">M</span> Moderate (4–{POCKET_SEVERITY.MODERATE_MAX_MM} mm)</li>
        <li><span className="legend-swatch severity-severe" aria-hidden="true">S</span> Severe (≥{POCKET_SEVERITY.MODERATE_MAX_MM + 1} mm)</li>
        <li><span className="legend-swatch is-active" aria-hidden="true">A</span> Active surface</li>
        <li><span className="legend-swatch is-missing" aria-hidden="true"><X size={12} /></span> Missing / skipped</li>
        <li><Droplet size={12} className="marker-bleeding" aria-hidden="true" /> Bleeding</li>
        <li><FlaskConical size={12} className="marker-suppuration" aria-hidden="true" /> Suppuration</li>
        <li>
          <ArrowRight size={12} aria-hidden="true" /> / <ArrowLeft size={12} aria-hidden="true" /> Charting direction for that row
        </li>
      </ul>
    </section>
  );
}
