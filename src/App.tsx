import { AudioLines, RotateCcw, ShieldCheck } from 'lucide-react';
import { type FormEvent, useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { CapturePanel } from './components/CapturePanel';
import { ChartTable } from './components/ChartTable';
import { ConfirmationsPanel } from './components/ConfirmationsPanel';
import { FixtureRecorder } from './components/FixtureRecorder';
import { HistoryPanel } from './components/HistoryPanel';
import { MetricsPanel } from './components/MetricsPanel';
import { StationPanel } from './components/StationPanel';
import { WorkflowPanel } from './components/WorkflowPanel';
import { createInitialSession, currentRecord } from './domain/clinicalEngine';
import { toothAt } from './domain/chart';
import { sessionReducer } from './domain/sessionReducer';
import type { WorkflowCommand } from './domain/grammar';
import type { SessionSettings, Surface, UtteranceInput } from './domain/types';
import { useLocalAsr } from './speech/useLocalAsr';
import type { AsrFinal, AsrStatus } from './speech/protocol';

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
  unsupported: 'Simulator available',
  offline: 'ASR offline',
  connecting: 'Connecting',
  'loading-model': 'Loading model',
  ready: 'Voice model ready',
  listening: 'Listening live',
  processing: 'Recognizing speech',
  error: 'Action needed',
};

const DEV_BUILD = (import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV;

function App() {
  const [session, dispatch] = useReducer(sessionReducer, undefined, () => createInitialSession());
  const [simulatedTranscript, setSimulatedTranscript] = useState('');
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
    )) {
      dispatch({ type: 'clear-current', occurredAt: performance.now() });
    }
  };

  const resetSession = () => {
    if (window.confirm('Reset the full chart, latency metrics, and event history?')) {
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
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Perio Voice clinical capture">
          <span className="brand-mark" aria-hidden="true"><AudioLines size={24} /></span>
          <span>
            <strong>PERIO VOICE</strong>
            <small>Structured clinical capture</small>
          </span>
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
            <RotateCcw size={17} aria-hidden="true" />
            Reset session
          </button>
        </div>
      </header>

      <main id="main-content" className="workspace">
        <section className="workspace-heading" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">Live periodontal workflow</p>
            <h1 id="page-title">Voice to chart, with context intact.</h1>
            <p>
              Speak naturally. Conversation is filtered out, ambiguous words are resolved against
              the active context, and values are committed only when they fit the sites that are
              actually open.
            </p>
          </div>
          <div className="trust-note">
            <ShieldCheck size={20} aria-hidden="true" />
            <span>
              <strong>Prototype guardrail</strong>
              Out-of-range and overflow values are rejected atomically; anything uncertain is held
              for your decision.
            </span>
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
          />

          <StationPanel
            session={session}
            record={record}
            tooth={tooth}
            onChangeContext={changeContext}
            onClear={clearActiveRecord}
          />

          <MetricsPanel session={session} cadence={speech.cadence} />

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
  );
}

export default App;
