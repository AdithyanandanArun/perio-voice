import { Activity, ClipboardList, History } from 'lucide-react';
import type { ClinicalEvent, ClinicalEventKind, StageName } from '../domain/types';

interface HistoryPanelProps {
  events: ClinicalEvent[];
}

const EVENT_LABELS: Record<ClinicalEventKind, string> = {
  depth_sequence: 'Depths recorded',
  recession_sequence: 'Recession recorded',
  bleeding: 'Finding updated',
  finding: 'Finding updated',
  correction: 'Value corrected',
  sequence_replacement: 'Sequence replaced',
  context: 'Context changed',
  undo: 'Change reversed',
  redo: 'Change reapplied',
  confirmation: 'Awaiting confirmation',
  ignored: 'Speech ignored',
  rejected: 'Input protected',
};

const STAGE_LABELS: Record<StageName, string> = {
  auto_chart: 'Automatic charting',
  speaker: 'Speaker',
  staleness: 'Context version',
  lexicon: 'Lexicon',
  lattice: 'Candidates',
  relevance: 'Relevance',
  context: 'Disambiguation',
  grammar: 'Grammar',
  negation: 'Polarity',
  correction: 'Correction',
  sequence: 'Sequence guard',
  commit: 'Commit',
};

/**
 * The audit trail doubles as the explanation. Every entry can be opened to show
 * which stage made which decision, so "why did that value not appear?" is
 * answerable without reading logs.
 */
export function HistoryPanel({ events }: HistoryPanelProps) {
  return (
    <section className="panel history-panel" aria-labelledby="history-title">
      <div className="panel-heading compact">
        <div>
          <p className="section-index">04 · AUDIT</p>
          <h2 id="history-title">Clinical event history</h2>
        </div>
        <History size={20} aria-hidden="true" />
      </div>
      <div className="event-list" aria-live="polite">
        {events.length === 0 ? (
          <div className="empty-state">
            <ClipboardList size={24} aria-hidden="true" />
            <span><strong>No chart events yet</strong>Use the microphone or simulator to begin.</span>
          </div>
        ) : events.slice(0, 8).map((event) => (
          <article className={`event event-${event.kind}`} key={event.id}>
            <Activity size={17} aria-hidden="true" />
            <div>
              <span>{EVENT_LABELS[event.kind]}</span>
              <strong>{event.message}</strong>
              <small>
                “{event.transcript}”{event.latencyMs !== null ? ` · ${event.latencyMs} ms` : ''}
              </small>
              {event.trace.length > 0 && (
                <details className="trace">
                  <summary>Why</summary>
                  <ol>
                    {event.trace.map((stage, index) => (
                      <li key={`${stage.stage}-${index}`} data-outcome={stage.outcome}>
                        <span>{STAGE_LABELS[stage.stage]}</span>
                        <em>{stage.outcome}</em>
                        <small>{stage.detail}</small>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
