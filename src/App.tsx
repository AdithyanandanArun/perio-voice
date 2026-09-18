import {
  Activity,
  AudioLines,
  ChartNoAxesCombined,
  LogOut,
  Menu,
  RotateCcw,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { AuthScreen } from './auth/AuthScreen';
import { resumeAccount, signOut, type Account } from './auth/api';
import { CapturePanel } from './components/CapturePanel';
import { ChartTable } from './components/ChartTable';
import { ConfirmationsPanel } from './components/ConfirmationsPanel';
import { FixtureRecorder } from './components/FixtureRecorder';
import { HistoryPanel } from './components/HistoryPanel';
import { MetricsPanel } from './components/MetricsPanel';
import { StationPanel } from './components/StationPanel';
import { WorkflowPanel } from './components/WorkflowPanel';
import { nextOpenPosition, toothAt } from './domain/chart';
import { createInitialSession, currentRecord } from './domain/clinicalEngine';
import type { WorkflowCommand } from './domain/grammar';
import { sessionReducer } from './domain/sessionReducer';
import type { SessionSettings, Surface, UtteranceInput } from './domain/types';
import type { AsrFinal, AsrStatus, ClinicalExpectation } from './speech/protocol';
import { useLocalAsr } from './speech/useLocalAsr';

const EXAMPLE_PHRASES = [
  'three four five',
  'bleeding',
  'four no three',
  'repeat that three four four',
  'tooth fifteen lingual',
  'no bleeding',
  'mobility two',
  'skip this tooth',
] as const;

const STATUS_LABELS: Record<AsrStatus, string> = {
  unsupported: 'Voice unavailable',
  offline: 'ASR offline',
  connecting: 'Connecting',
  'loading-model': 'Loading model',
  ready: 'Voice ready',
  listening: 'Listening',
  processing: 'Recognizing speech',
  error: 'Action needed',
};

const DEV_BUILD = (import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV;

interface AppProps {
  /** Test/bootstrap escape hatch. Omit in production so the server session is authoritative. */
  initialAccount?: Account | null;
  showDeveloperTools?: boolean;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function LoadingScreen() {
  return (
    <main className="session-loading" aria-live="polite">
      <span className="brand-mark" aria-hidden="true"><AudioLines size={24} /></span>
      <p>Opening your clinical workspace…</p>
    </main>
  );
}

function ClinicalWorkspace({
  account,
  onLogout,
  showDeveloperTools,
}: {
  account: Account;
  onLogout: () => void;
  showDeveloperTools: boolean;
}) {
  const [session, dispatch] = useReducer(sessionReducer, undefined, () => createInitialSession());
  const [simulatedTranscript, setSimulatedTranscript] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const simulatorStartedAt = useRef<number | null>(null);
  const acceptSpeechFinals = useRef(true);
  const contextVersionRef = useRef(session.context.version);
  contextVersionRef.current = session.context.version;

  const commitTranscript = useCallback(
    (transcript: string, startedAt: number, observedAt: number) => {
      dispatch({ type: 'transcript', transcript, timing: { startedAt, observedAt } });
    },
    [],
  );

  const commitFinal = useCallback((final: AsrFinal) => {
    const input: UtteranceInput = {
      transcript: final.transcript,
      words: final.words,
      timing: final.timing,
      source: 'asr',
      utteranceId: final.utteranceId,
      audioMs: final.audioMs,
      decodeMs: final.decodeMs,
      observedVersion: final.observedVersion,
      speaker: final.speaker,
      alternatives: final.alternatives,
    };
    dispatch({ type: 'utterance', input });
  }, []);

  const speech = useLocalAsr({
    onFinal: (final) => {
      if (acceptSpeechFinals.current) commitFinal(final);
    },
    contextVersion: () => contextVersionRef.current,
  });
  const showFixtureRecorder = DEV_BUILD
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('record') === '1';

  const record = currentRecord(session);
  const tooth = toothAt(session.teeth, session.context.tooth);
  const expectation: ClinicalExpectation =
    nextOpenPosition(record, session.context.measurement) < 3 ? 'depths' : 'clinical';
  const declareExpectation = speech.declareExpectation;
  useEffect(() => {
    declareExpectation(expectation);
  }, [declareExpectation, expectation, speech.status]);
  const chartRows = useMemo(
    () => Object.values(session.charts)
      .filter((row) =>
        row.updatedAt !== null
        || (row.tooth === session.context.tooth && row.surface === session.context.surface))
      .sort((a, b) => a.tooth - b.tooth || a.surface.localeCompare(b.surface)),
    [session.charts, session.context.surface, session.context.tooth],
  );

  const submitTranscript = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const transcript = simulatedTranscript.trim();
    if (!transcript) return;
    const observedAt = performance.now();
    commitTranscript(transcript, simulatorStartedAt.current ?? observedAt, observedAt);
    setSimulatedTranscript('');
    simulatorStartedAt.current = null;
  };

  const changeSimulated = (value: string) => {
    if (!value) simulatorStartedAt.current = null;
    else if (simulatorStartedAt.current === null) simulatorStartedAt.current = performance.now();
    setSimulatedTranscript(value);
  };

  const runExample = (transcript: string) => {
    const now = performance.now();
    commitTranscript(transcript, now, performance.now());
  };

  const changeContext = (patch: { tooth?: number; surface?: Surface }) => {
    dispatch({ type: 'context', patch, occurredAt: performance.now() });
  };
  const runCommand = (command: WorkflowCommand) => {
    dispatch({ type: 'workflow', command, occurredAt: performance.now() });
  };
  const changeSettings = (patch: Partial<SessionSettings>) => {
    dispatch({ type: 'settings', patch });
  };
  const resolveConfirmation = (id: number, approve: boolean) => {
    dispatch({ type: 'confirmation', id, approve, occurredAt: performance.now() });
  };
  const clearActiveRecord = () => {
    if (window.confirm(
      `Clear all values for tooth ${session.context.tooth}, ${session.context.surface}?`,
    )) dispatch({ type: 'clear-current', occurredAt: performance.now() });
  };
  const resetSession = () => {
    if (window.confirm('Reset the full chart, response metrics, and event history?')) {
      acceptSpeechFinals.current = false;
      speech.stop();
      dispatch({ type: 'reset-session' });
    }
  };
  const startSpeech = () => {
    acceptSpeechFinals.current = true;
    void speech.start();
  };

  return (
    <div className="platform-shell">
      <button
        type="button"
        className="mobile-nav-toggle"
        aria-label={navigationOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={navigationOpen}
        onClick={() => setNavigationOpen((open) => !open)}
      >
        {navigationOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      <aside className={`sidebar ${navigationOpen ? 'is-open' : ''}`} aria-label="Primary navigation">
        <div className="brand sidebar-brand" aria-label="Perio Voice">
          <span className="brand-mark" aria-hidden="true"><AudioLines size={22} /></span>
          <span><strong>Perio Voice</strong><small>Clinical workspace</small></span>
        </div>
        <nav>
          <a className="is-active" href="#charting" onClick={() => setNavigationOpen(false)}>
            <ChartNoAxesCombined size={18} aria-hidden="true" /> Charting
          </a>
          <a href="#voice-profile" onClick={() => setNavigationOpen(false)}>
            <UserRound size={18} aria-hidden="true" /> Voice profile
          </a>
          <a href="#activity" onClick={() => setNavigationOpen(false)}>
            <Activity size={18} aria-hidden="true" /> Session activity
          </a>
        </nav>
        <div className="sidebar-account">
          <span className="account-avatar" aria-hidden="true">{initials(account.name)}</span>
          <span><strong>{account.name}</strong><small>{account.email}</small></span>
          <button type="button" aria-label="Sign out" onClick={onLogout}>
            <LogOut size={18} aria-hidden="true" />
          </button>
        </div>
      </aside>

      <div className="platform-main">
        <header className="topbar">
          <div>
            <p className="topbar-kicker">Periodontal chart</p>
            <strong>New clinical session</strong>
          </div>
          <div className="topbar-actions">
            <span
              className={`system-status ${speech.listening ? 'is-live' : ''}`}
              data-status={speech.status}
            >
              <span className="status-dot" aria-hidden="true" />
              {STATUS_LABELS[speech.status]}
            </span>
            <button className="button button-quiet" type="button" onClick={resetSession}>
              <RotateCcw size={16} aria-hidden="true" /> Reset session
            </button>
          </div>
        </header>

        <main id="main-content" className="workspace">
          <section className="workspace-heading" id="charting" aria-labelledby="page-title">
            <div>
              <p className="eyebrow">Live charting</p>
              <h1 id="page-title">Periodontal examination</h1>
              <p>Record measurements and findings while keeping the active tooth in view.</p>
            </div>
            <div className="trust-note">
              <ShieldCheck size={19} aria-hidden="true" />
              <span><strong>Clinical safeguards active</strong>Uncertain entries wait for review.</span>
            </div>
          </section>

          {showFixtureRecorder && <FixtureRecorder />}
          <ConfirmationsPanel pending={session.pending} onResolve={resolveConfirmation} />

          <div className="dashboard-grid">
            <CapturePanel
              speech={speech}
              statusLabels={STATUS_LABELS}
              examples={EXAMPLE_PHRASES}
              simulatedTranscript={simulatedTranscript}
              onSimulatedChange={changeSimulated}
              onSubmit={submitTranscript}
              onExample={runExample}
              onStart={startSpeech}
              showDeveloperTools={showDeveloperTools}
            />
            <StationPanel
              session={session}
              record={record}
              tooth={tooth}
              onChangeContext={changeContext}
              onClear={clearActiveRecord}
            />
            <div id="activity"><MetricsPanel session={session} cadence={speech.cadence} /></div>
            <HistoryPanel events={session.history} />
            <WorkflowPanel
              session={session}
              onCommand={runCommand}
              onSettings={changeSettings}
              speakerEnrolled={speech.enrollment?.enrolled === true}
            />
          </div>
          <ChartTable rows={chartRows} teeth={session.teeth} />
        </main>
      </div>
    </div>
  );
}

function App({ initialAccount, showDeveloperTools }: AppProps) {
  const [account, setAccount] = useState<Account | null>(initialAccount ?? null);
  const [loading, setLoading] = useState(initialAccount === undefined);

  useEffect(() => {
    if (initialAccount !== undefined) return;
    let active = true;
    void resumeAccount()
      .then((resumed) => {
        if (active) setAccount(resumed);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [initialAccount]);

  const logout = async () => {
    await signOut();
    setAccount(null);
  };

  if (loading) return <LoadingScreen />;
  if (!account) return <AuthScreen onAuthenticated={setAccount} />;

  const developerTools = showDeveloperTools ?? (
    DEV_BUILD
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('tools') === '1'
  );
  return (
    <ClinicalWorkspace
      account={account}
      onLogout={() => void logout()}
      showDeveloperTools={developerTools}
    />
  );
}

export default App;
