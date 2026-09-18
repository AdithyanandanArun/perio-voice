import { LoaderCircle, ShieldCheck, ShieldOff, UserCheck } from 'lucide-react';
import type { SpeakerVerdict } from '../domain/types';
import type { EnrollmentState } from '../speech/protocol';
import { ENROLLMENT_PASSAGES } from '../speech/enrollmentPassages';
import { ENROLLMENT_SECONDS } from '../speech/useLocalAsr';

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
  const samples = enrollment?.samples ?? 0;
  const passage = ENROLLMENT_PASSAGES[samples % ENROLLMENT_PASSAGES.length];
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

      <figure className="enroll-prompt" aria-live="polite">
        <figcaption>
          {enrolling
            ? `Recording for ${ENROLLMENT_SECONDS} seconds — read this aloud now:`
            : `Press “${enrolled ? 'Add another sample' : 'Enrol my voice'}”, then read this aloud at your normal pace:`}
        </figcaption>
        <blockquote>“{passage}”</blockquote>
      </figure>

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
        Your profile is stored for this account by the local service, and you can revoke it at any
        time. Each extra sample asks for a different passage.
      </p>
    </div>
  );
}
