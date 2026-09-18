import { LoaderCircle, ShieldCheck, ShieldOff, UserCheck } from 'lucide-react';
import type { SpeakerVerdict } from '../domain/types';
import type { EnrollmentState } from '../speech/protocol';

interface SpeakerPanelProps {
  enrollment: EnrollmentState | null;
  verdict: SpeakerVerdict | null;
  enrolling: boolean;
  supported: boolean;
  onEnroll: () => void;
  onRevoke: () => void;
}

const DECISION_LABELS: Record<SpeakerVerdict['decision'], string> = {
  clinician: 'Enrolled clinician',
  other: 'Another speaker',
  unknown: 'Not recognized',
};

/**
 * Voice attribution is visible and reversible on purpose. Hidden attribution is
 * worse than none: a clinician cannot correct a decision they cannot see.
 */
export function SpeakerPanel({
  enrollment,
  verdict,
  enrolling,
  supported,
  onEnroll,
  onRevoke,
}: SpeakerPanelProps) {
  const enrolled = enrollment?.enrolled === true;
  return (
    <div className="speaker-panel" id="voice-profile" aria-labelledby="speaker-title">
      <div className="speaker-heading">
        <span id="speaker-title">
          <UserCheck size={17} aria-hidden="true" />
          My voice profile
        </span>
        <span className={`speaker-state ${enrolled ? 'is-enrolled' : ''}`} aria-live="polite">
          {enrolled ? `Enrolled · ${enrollment?.samples ?? 0} sample(s)` : 'No voice enrolled'}
        </span>
      </div>

      {verdict && (
        <p className="speaker-verdict" data-decision={verdict.decision}>
          <strong>Last utterance: {DECISION_LABELS[verdict.decision]}</strong>
          <small>similarity {verdict.similarity.toFixed(3)}</small>
        </p>
      )}

      <div className="speaker-actions">
        <button
          className="button button-quiet"
          type="button"
          onClick={onEnroll}
          disabled={enrolling || !supported}
        >
          {enrolling
            ? <LoaderCircle className="spin" size={16} aria-hidden="true" />
            : <ShieldCheck size={16} aria-hidden="true" />}
          {enrolling ? 'Listening…' : enrolled ? 'Add another sample' : 'Enrol my voice'}
        </button>
        {enrolled && (
          <button className="button button-quiet" type="button" onClick={onRevoke}>
            <ShieldOff size={16} aria-hidden="true" />
            Revoke profile
          </button>
        )}
      </div>
      <p className="helper-text">
        Your profile is stored for this account by the local service. Read a sentence aloud for a
        few seconds to enrol; you can revoke it at any time.
      </p>
    </div>
  );
}
