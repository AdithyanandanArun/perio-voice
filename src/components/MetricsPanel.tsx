import { Clock3 } from 'lucide-react';
import { latencySummary, percentile } from '../domain/session';
import type { CadenceInfo } from '../speech/protocol';
import type { ClinicalSession } from '../domain/types';

interface MetricsPanelProps {
  session: ClinicalSession;
  cadence: CadenceInfo | null;
}

function formatLatency(value: number | null): string {
  return value === null ? '—' : `${value} ms`;
}

export function MetricsPanel({ session, cadence }: MetricsPanelProps) {
  const metrics = latencySummary(session.latencySamples);
  const parserP95 = percentile(session.parserSamples, 0.95);
  const { counters } = session;

  return (
    <section className="panel metrics-panel" aria-labelledby="metrics-title">
      <div className="panel-heading compact">
        <div>
          <p className="section-index">03 · LATENCY</p>
          <h2 id="metrics-title">Input response</h2>
        </div>
        <Clock3 size={20} aria-hidden="true" />
      </div>
      <div className="metric-grid">
        <article><span>Latest</span><strong>{formatLatency(metrics.latest)}</strong></article>
        <article><span>Average</span><strong>{formatLatency(metrics.average)}</strong></article>
        <article><span>P95 tail</span><strong>{formatLatency(metrics.p95)}</strong></article>
      </div>
      <p className="helper-text">
        Measured from detected speech start (or simulator input start) to structured chart commit.
      </p>
      <dl className="counter-grid" aria-label="Pipeline decisions this session">
        <div><dt>Charted</dt><dd>{counters.chartable}</dd></div>
        <div><dt>Filtered as conversation</dt><dd>{counters.nonChartable}</dd></div>
        <div><dt>Held as uncertain</dt><dd>{counters.uncertain}</dd></div>
        <div><dt>Blocked by attribution</dt><dd>{counters.blockedSpeaker}</dd></div>
        <div><dt>Refused as stale</dt><dd>{counters.staleContext}</dd></div>
        <div>
          <dt>Parser p95</dt>
          <dd>{parserP95 === null ? '—' : `${parserP95.toFixed(2)} ms`}</dd>
        </div>
      </dl>
      {cadence && cadence.adaptive && (
        <p className="helper-text cadence-note">
          Endpoint now {cadence.endSilenceMs} ms — adapted to {cadence.wordsPerSecond.toFixed(1)}{' '}
          words/second with p90 pauses of {cadence.pauseP90Ms} ms.
        </p>
      )}
    </section>
  );
}
