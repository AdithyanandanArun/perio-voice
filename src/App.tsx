import { AudioLines } from 'lucide-react';
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
import { nextOpenPosition, toothAt } from './domain/chart';
import { createInitialSession, currentRecord } from './domain/clinicalEngine';
import type { WorkflowCommand } from './domain/grammar';
import { sessionReducer } from './domain/sessionReducer';
import type { SessionSettings, Surface, UtteranceInput } from './domain/types';
import { GraphPage } from './pages/GraphPage';
import { PerioTestPage } from './pages/PerioTestPage';
import { ProfilePage } from './pages/ProfilePage';
import { TopNav } from './pages/TopNav';
import { useHashRoute } from './pages/useHashRoute';
import type { AsrFinal, AsrStatus, ClinicalExpectation } from './speech/protocol';
import { useLocalAsr } from './speech/useLocalAsr';
import { applyTheme, persistTheme, resolveInitialTheme, type ThemePreference } from './theme';

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

function LoadingScreen() {
  return (
    <main className="session-loading" aria-live="polite">
      <span className="brand-mark" aria-hidden="true"><AudioLines size={24} /></span>
      <p>Opening your clinical workspace…</p>
    </main>
  );
}

/**
 * Owns the live speech session and the chart state above the pages, so
 * switching pages never drops the microphone or loses in-progress charting.
 * Only the presentation swaps; this component, its reducer and its `useLocalAsr`
 * instance stay mounted for the lifetime of the signed-in session.
 */
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
  const [route] = useHashRoute();
  const [darkTheme, setDarkTheme] = useState(() => resolveInitialTheme() === 'dark');
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
  const toggleTheme = (dark: boolean) => {
    const next: ThemePreference = dark ? 'dark' : 'light';
    setDarkTheme(dark);
    applyTheme(next);
    persistTheme(next);
  };

  return (
    <div className="platform-shell">
      <a className="skip-link" href="#main-content">Skip to clinical chart</a>
      <TopNav route={route} account={account} onLogout={onLogout} />
      <main id="main-content" className="workspace">
        {route === 'profile' && (
          <ProfilePage
            account={account}
            speech={speech}
            settings={session.settings}
            onSettings={changeSettings}
            darkTheme={darkTheme}
            onToggleTheme={toggleTheme}
          />
        )}
        {route === 'perio' && (
          <PerioTestPage
            session={session}
            record={record}
            tooth={tooth}
            chartRows={chartRows}
            speech={speech}
            statusLabels={STATUS_LABELS}
            examples={EXAMPLE_PHRASES}
            simulatedTranscript={simulatedTranscript}
            onSimulatedChange={changeSimulated}
            onSubmit={submitTranscript}
            onExample={runExample}
            onStart={startSpeech}
            showDeveloperTools={showDeveloperTools}
            showFixtureRecorder={showFixtureRecorder}
            onChangeContext={changeContext}
            onClear={clearActiveRecord}
            onCommand={runCommand}
            onResetSession={resetSession}
            onResolveConfirmation={resolveConfirmation}
          />
        )}
        {route === 'graph' && <GraphPage session={session} clinicianName={account.name} />}
      </main>
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
