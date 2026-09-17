import { CircleAlert, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { ConfirmationReason, PendingConfirmation } from '../domain/types';

interface ConfirmationsPanelProps {
  pending: PendingConfirmation[];
  onResolve: (id: number, approve: boolean) => void;
}

const REASON_LABELS: Record<ConfirmationReason, string> = {
  uncertain_relevance: 'Unclear whether this was clinical',
  ambiguous_correction: 'Correction target is not in the active station',
  low_confidence_polarity: 'Polarity is uncertain',
  unknown_speaker: 'Speaker was not recognized',
  sequence_mismatch: 'Values do not line up with the open sites',
};

/**
 * Held utterances. Approving replays the original utterance through the whole
 * pipeline with the operator's approval attached, so an approved value is
 * committed and audited the same way a spoken one is.
 */
export function ConfirmationsPanel({ pending, onResolve }: ConfirmationsPanelProps) {
  if (pending.length === 0) return null;
  return (
    <section className="panel confirmations-panel" aria-labelledby="confirmations-title" role="region">
      <div className="panel-heading compact">
        <div>
          <p className="section-index">NEEDS A DECISION</p>
          <h2 id="confirmations-title">Held for confirmation</h2>
        </div>
        <CircleAlert size={20} aria-hidden="true" />
      </div>
      <ul className="confirmation-list" aria-live="polite">
        {pending.map((item) => (
          <li key={item.id}>
            <div>
              <span className="confirmation-reason">{REASON_LABELS[item.reason]}</span>
              <strong>“{item.transcript}”</strong>
              <small>{item.message}</small>
            </div>
            <div className="confirmation-actions">
              <button
                className="button button-primary"
                type="button"
                onClick={() => onResolve(item.id, true)}
              >
                <ThumbsUp size={16} aria-hidden="true" />
                Chart it
              </button>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => onResolve(item.id, false)}
              >
                <ThumbsDown size={16} aria-hidden="true" />
                Discard
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
