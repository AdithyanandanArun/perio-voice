import { Check, Trash2 } from 'lucide-react';
import {
  SURFACE_SITES,
  type ClinicalSession,
  type PerioRecord,
  type Surface,
  type ToothRecord,
} from '../domain/types';

interface StationPanelProps {
  session: ClinicalSession;
  record: PerioRecord;
  tooth: ToothRecord;
  onChangeContext: (patch: { tooth?: number; surface?: Surface }) => void;
  onClear: () => void;
}

const BINARY_LABELS: Record<string, string> = {
  bleeding: 'Bleeding on probing',
  suppuration: 'Suppuration',
  plaque: 'Plaque',
  calculus: 'Calculus',
};

function findingText(value: boolean | null): string {
  if (value === null) return 'Not recorded';
  return value ? 'Yes · present' : 'No · absent';
}

function findingClass(value: boolean | null): string {
  if (value === null) return '';
  return value ? 'is-positive' : 'is-negative';
}

export function StationPanel({
  session,
  record,
  tooth,
  onChangeContext,
  onClear,
}: StationPanelProps) {
  const sites = SURFACE_SITES[session.context.surface];
  const completedSites = record.probingDepths.filter((value) => value !== null).length;
  const recessionRecorded = record.recession.some((value) => value !== null);

  return (
    <section className="panel chart-panel" aria-labelledby="chart-title">
      <div className="panel-heading">
        <div>
          <p className="section-index">02 · STRUCTURE</p>
          <h2 id="chart-title">Active periodontal chart</h2>
        </div>
        <span className="context-badge">Tooth {session.context.tooth}</span>
      </div>

      <fieldset className="context-controls">
        <legend>Clinical context</legend>
        <label>
          <span>Tooth</span>
          <select
            aria-label="Current tooth"
            value={session.context.tooth}
            onChange={(event) => onChangeContext({ tooth: Number(event.target.value) })}
          >
            {Array.from({ length: 32 }, (_, index) => index + 1).map((number) => (
              <option key={number} value={number}>Tooth {number}</option>
            ))}
          </select>
        </label>
        <div className="surface-control">
          <span>Surface</span>
          <div className="segmented-control">
            {(['buccal', 'lingual'] as const).map((surface) => (
              <button
                key={surface}
                type="button"
                aria-pressed={session.context.surface === surface}
                onClick={() => onChangeContext({ surface })}
              >
                {surface[0].toUpperCase() + surface.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </fieldset>

      <div className="sequence-status">
        <div>
          <span>Sequence position</span>
          <strong>{completedSites} of 3 sites recorded</strong>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-label="Three-site sequence completion"
          aria-valuemin={0}
          aria-valuemax={3}
          aria-valuenow={completedSites}
        >
          <span style={{ transform: `scaleX(${completedSites / 3})` }} />
        </div>
      </div>

      <div
        className="site-grid"
        aria-label={`Tooth ${record.tooth} ${record.surface} probing depths`}
      >
        {sites.map((site, index) => {
          const value = record.probingDepths[index];
          const isNext = session.context.position === index;
          return (
            <article
              className={`site-card ${isNext ? 'is-next' : ''} ${value !== null ? 'has-value' : ''}`}
              key={site}
            >
              <div className="site-card-label">
                <span>{site}</span>
                {value !== null && <Check size={16} aria-label="Recorded" />}
              </div>
              <strong aria-label={`${site} probing depth ${value ?? 'not recorded'}`}>
                {value ?? '—'}
              </strong>
              <small>{value === null ? (isNext ? 'Listening next' : 'Pending') : 'millimeters'}</small>
            </article>
          );
        })}
      </div>

      {recessionRecorded && (
        <div className="recession-row" aria-label="Recorded recession">
          <span>Recession</span>
          <div>
            {sites.map((site, index) => (
              <span key={site} aria-label={`${site} recession ${record.recession[index] ?? 'not recorded'}`}>
                <small>{site}</small>
                {record.recession[index] ?? '—'}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="finding-row">
        <div>
          <span>Bleeding on probing</span>
          <small>Applies to active tooth and surface</small>
        </div>
        <span className={`finding-value ${findingClass(record.bleeding)}`}>
          {findingText(record.bleeding)}
        </span>
      </div>

      <ul className="finding-list" aria-label="Other findings at this station">
        {(['suppuration', 'plaque', 'calculus'] as const).map((finding) => (
          <li key={finding} className={findingClass(record[finding])}>
            <span>{BINARY_LABELS[finding]}</span>
            <strong aria-label={`${BINARY_LABELS[finding]} ${findingText(record[finding])}`}>
              {findingText(record[finding])}
            </strong>
          </li>
        ))}
        <li className={tooth.mobility === null ? '' : 'is-graded'}>
          <span>Mobility</span>
          <strong aria-label={`Mobility grade ${tooth.mobility ?? 'not recorded'}`}>
            {tooth.mobility === null ? 'Not recorded' : `Grade ${tooth.mobility}`}
          </strong>
        </li>
        <li className={tooth.furcation === null ? '' : 'is-graded'}>
          <span>Furcation</span>
          <strong aria-label={`Furcation grade ${tooth.furcation ?? 'not recorded'}`}>
            {tooth.furcation === null ? 'Not recorded' : `Grade ${tooth.furcation}`}
          </strong>
        </li>
      </ul>

      <button className="button button-quiet clear-button" type="button" onClick={onClear}>
        <Trash2 size={17} aria-hidden="true" />
        Clear active record
      </button>
    </section>
  );
}
