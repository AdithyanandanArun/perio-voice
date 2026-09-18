import { useState } from 'react';
import { Droplet, FlaskConical, X } from 'lucide-react';
import { chartKey } from '../domain/chart';
import type { ClinicalSession, PerioRecord, ToothRecord } from '../domain/types';
import './ToothChart.css';

/**
 * Pocket-severity bands, taken from the deepest recorded probing depth on the
 * tooth (either surface). One named constant so the thresholds are not
 * scattered across the render.
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

/** Upper arch, patient's right to left — the conventional chart order. */
const UPPER_ARCH: readonly number[] = Array.from({ length: 16 }, (_, index) => index + 1);
/**
 * Lower arch, drawn right-to-left in the same visual column as the upper arch
 * so tooth 1 sits above tooth 32 and tooth 16 sits above tooth 17, matching a
 * real periodontal chart.
 */
const LOWER_ARCH: readonly number[] = Array.from({ length: 16 }, (_, index) => 32 - index);

interface ToothStatus {
  tooth: number;
  active: boolean;
  missing: boolean;
  charted: boolean;
  deepestDepthMm: number | null;
  severity: PocketSeverity | null;
  bleeding: boolean;
  suppuration: boolean;
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

function statusFor(session: ClinicalSession, tooth: number): ToothStatus {
  const buccal = session.charts[chartKey(tooth, 'buccal')];
  const lingual = session.charts[chartKey(tooth, 'lingual')];
  const toothRecord: ToothRecord | undefined = session.teeth[tooth];

  const missing = toothRecord?.missing === true;
  const deepestDepthMm = Math.max(
    deepestOf(buccal) ?? -Infinity,
    deepestOf(lingual) ?? -Infinity,
  );
  const hasDepth = deepestDepthMm !== -Infinity;
  const charted =
    isRecordCharted(buccal) || isRecordCharted(lingual) || toothRecord?.updatedAt != null;

  return {
    tooth,
    active: session.context.tooth === tooth,
    missing,
    charted,
    deepestDepthMm: hasDepth ? deepestDepthMm : null,
    severity: hasDepth ? severityFor(deepestDepthMm) : null,
    bleeding: buccal?.bleeding === true || lingual?.bleeding === true,
    suppuration: buccal?.suppuration === true || lingual?.suppuration === true,
  };
}

function accessibleName(status: ToothStatus): string {
  if (status.missing) return `Tooth ${status.tooth}: missing`;

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
  return `Tooth ${status.tooth}: ${parts.join(', ')}`;
}

interface ToothCellProps {
  status: ToothStatus;
  selected: boolean;
  onSelect: (tooth: number) => void;
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
      onClick={() => onSelect(status.tooth)}
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
 * A 2D full-mouth status chart. Purely a rendering of session state: it never
 * derives clinical meaning beyond a display threshold, and clicking a tooth
 * only changes local UI state (which detail card is open), never the chart.
 */
export function ToothChart({ session }: ToothChartProps) {
  const [selectedTooth, setSelectedTooth] = useState<number | null>(null);

  const upperStatuses = UPPER_ARCH.map((tooth) => statusFor(session, tooth));
  const lowerStatuses = LOWER_ARCH.map((tooth) => statusFor(session, tooth));
  const selectedStatus =
    selectedTooth === null ? null : statusFor(session, selectedTooth);

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

      <div className="tooth-arch" aria-label="Upper arch, teeth 1 to 16">
        {upperStatuses.map((status) => (
          <ToothCell
            key={status.tooth}
            status={status}
            selected={status.tooth === selectedTooth}
            onSelect={setSelectedTooth}
          />
        ))}
      </div>
      <div className="tooth-arch" aria-label="Lower arch, teeth 17 to 32">
        {lowerStatuses.map((status) => (
          <ToothCell
            key={status.tooth}
            status={status}
            selected={status.tooth === selectedTooth}
            onSelect={setSelectedTooth}
          />
        ))}
      </div>

      {selectedStatus && (
        <div className="tooth-detail" role="status">
          <strong>Tooth {selectedStatus.tooth}</strong>
          <span>{accessibleName(selectedStatus)}</span>
        </div>
      )}

      <ul className="tooth-legend" aria-label="Legend">
        <li><span className="legend-swatch severity-healthy" aria-hidden="true">H</span> Healthy (≤{POCKET_SEVERITY.HEALTHY_MAX_MM} mm)</li>
        <li><span className="legend-swatch severity-moderate" aria-hidden="true">M</span> Moderate (4–{POCKET_SEVERITY.MODERATE_MAX_MM} mm)</li>
        <li><span className="legend-swatch severity-severe" aria-hidden="true">S</span> Severe (≥{POCKET_SEVERITY.MODERATE_MAX_MM + 1} mm)</li>
        <li><span className="legend-swatch is-active" aria-hidden="true">A</span> Active tooth</li>
        <li><span className="legend-swatch is-missing" aria-hidden="true"><X size={12} /></span> Missing / skipped</li>
        <li><Droplet size={12} className="marker-bleeding" aria-hidden="true" /> Bleeding</li>
        <li><FlaskConical size={12} className="marker-suppuration" aria-hidden="true" /> Suppuration</li>
      </ul>
    </section>
  );
}
