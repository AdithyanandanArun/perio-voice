import { Moon, ShieldCheck, Sun, UserRound } from 'lucide-react';
import type { Account } from '../auth/api';
import { SpeakerPanel } from '../components/SpeakerPanel';
import type { SessionSettings } from '../domain/types';
import type { LocalAsrController } from '../speech/useLocalAsr';
import { usePageTitle } from './usePageTitle';

interface ProfilePageProps {
  account: Account;
  speech: LocalAsrController;
  settings: SessionSettings;
  onSettings: (patch: Partial<SessionSettings>) => void;
  darkTheme: boolean;
  onToggleTheme: (dark: boolean) => void;
}

export function ProfilePage({
  account,
  speech,
  settings,
  onSettings,
  darkTheme,
  onToggleTheme,
}: ProfilePageProps) {
  const headingRef = usePageTitle('Profile');
  const speakerEnrolled = speech.enrollment?.enrolled === true;

  return (
    <div className="page profile-page">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Clinician profile</p>
          <h1 id="page-title" tabIndex={-1} ref={headingRef}>Profile</h1>
          <p>Manage your voice enrollment, account and workspace preferences.</p>
        </div>
      </div>

      <section className="panel account-panel" aria-labelledby="account-title">
        <div className="panel-heading compact">
          <div>
            <p className="section-index">ACCOUNT</p>
            <h2 id="account-title">
              <UserRound size={18} aria-hidden="true" /> Signed-in account
            </h2>
          </div>
        </div>
        <dl className="account-details">
          <div><dt>Name</dt><dd>{account.name}</dd></div>
          <div><dt>Email</dt><dd>{account.email}</dd></div>
        </dl>
      </section>

      <section className="panel" aria-labelledby="voice-enrollment-title">
        <div className="panel-heading compact">
          <div>
            <p className="section-index">VOICE ENROLLMENT</p>
            <h2 id="voice-enrollment-title">Enrolled clinician voice</h2>
          </div>
        </div>
        <SpeakerPanel
          enrollment={speech.enrollment}
          verdict={speech.speaker}
          enrolling={speech.enrolling}
          supported={speech.supported}
          onEnroll={() => void speech.enroll()}
          onRevoke={() => void speech.revokeEnrollment()}
        />
      </section>

      <section className="panel" aria-labelledby="preferences-title">
        <div className="panel-heading compact">
          <div>
            <p className="section-index">PREFERENCES</p>
            <h2 id="preferences-title">Workspace preferences</h2>
          </div>
        </div>
        <fieldset className="workflow-settings">
          <legend>Session behaviour</legend>
          <label>
            <input
              type="checkbox"
              checked={settings.requireSpeaker}
              disabled={!speakerEnrolled}
              onChange={(event) => onSettings({ requireSpeaker: event.target.checked })}
            />
            <span>
              Require the enrolled clinician
              <small>
                {speakerEnrolled
                  ? 'Only the enrolled voice can write to the chart.'
                  : 'Enrol a voice first; without one, every utterance would be held.'}
              </small>
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={darkTheme}
              onChange={(event) => onToggleTheme(event.target.checked)}
            />
            <span>
              Dark theme
              <small>
                {darkTheme ? <Moon size={12} aria-hidden="true" /> : <Sun size={12} aria-hidden="true" />}
                {' '}Overrides the operating system preference for this device.
              </small>
            </span>
          </label>
        </fieldset>
        <p className="helper-text">
          <ShieldCheck size={14} aria-hidden="true" /> Preferences apply to this workspace only.
        </p>
      </section>
    </div>
  );
}
