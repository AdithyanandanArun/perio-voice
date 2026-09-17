import type { PerioRecord, ToothRecord } from '../domain/types';

interface ChartTableProps {
  rows: PerioRecord[];
  teeth: Record<number, ToothRecord>;
}

function cell(value: number | null): string {
  return value === null ? '—' : String(value);
}

function flag(value: boolean | null): string {
  if (value === null) return '—';
  return value ? 'Yes' : 'No';
}

export function ChartTable({ rows, teeth }: ChartTableProps) {
  return (
    <section className="panel overview-panel" aria-labelledby="overview-title">
      <div className="panel-heading">
        <div>
          <p className="section-index">SESSION OVERVIEW</p>
          <h2 id="overview-title">Structured chart records</h2>
        </div>
        <span className="record-count">
          {rows.length} context{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">
            All periodontal measurements recorded in this session
          </caption>
          <thead>
            <tr>
              <th>Tooth</th>
              <th>Surface</th>
              <th>Site 1</th>
              <th>Site 2</th>
              <th>Site 3</th>
              <th>Bleeding</th>
              <th>Suppuration</th>
              <th>Plaque</th>
              <th>Calculus</th>
              <th>Mobility</th>
              <th>Furcation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const tooth = teeth[row.tooth];
              return (
                <tr key={`${row.tooth}-${row.surface}`}>
                  <th scope="row">{row.tooth}</th>
                  <td>{row.surface}</td>
                  {row.probingDepths.map((value, index) => <td key={index}>{cell(value)}</td>)}
                  <td>{flag(row.bleeding)}</td>
                  <td>{flag(row.suppuration)}</td>
                  <td>{flag(row.plaque)}</td>
                  <td>{flag(row.calculus)}</td>
                  <td>{cell(tooth?.mobility ?? null)}</td>
                  <td>{cell(tooth?.furcation ?? null)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
