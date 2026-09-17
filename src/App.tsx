import {
  Activity,
  AudioLines,
  Check,
  CircleAlert,
  ClipboardList,
  Clock3,
  History,
  LoaderCircle,
  Mic,
  MicOff,
  Radio,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  createInitialSession,
  currentRecord,
  latencySummary,
} from './domain/clinicalEngine';
import { sessionReducer } from './domain/sessionReducer';
import { SURFACE_SITES, type ClinicalEventKind, type Surface } from './domain/types';
import { useLocalAsr } from './speech/useLocalAsr';
import type { AsrStatus } from './speech/protocol';

const EXAMPLE_PHRASES = [
  'three four five',
  'bleeding',
  'four no three',
  'repeat that three four four',
  'tooth fifteen lingual',
  'no bleeding',
] as const;

const EVENT_LABELS: Record<ClinicalEventKind, string> = {
  depth_sequence: 'Depths recorded',
  bleeding: 'Finding updated',
  correction: 'Value corrected',
  sequence_replacement: 'Sequence replaced',
  context: 'Context changed',
  ignored: 'Speech ignored',
  rejected: 'Input protected',
};

function formatLatency(value: number | null): string {
  return value === null ? '—' : `${value} ms`;
}

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

function App() {
  const [session, dispatch] = useReducer(sessionReducer, undefined, createInitialSession);
  const [simulatedTranscript, setSimulatedTranscript] = useState('');
  const simulatorStartedAt = useRef<number | null>(null);
  const acceptSpeechFinals = useRef(true);

  const commitTranscript = useCallback((transcript: string, startedAt: number, observedAt: number) => {
    dispatch({ type: 'transcript', transcript, timing: { startedAt, observedAt } });
  }, []);

  const speech = useLocalAsr({
    onFinal: (transcript, timing) => {
      if (acceptSpeechFinals.current) {
        commitTranscript(transcript, timing.startedAt, timing.observedAt);
      }
    },
  });

  const startSpeech = () => {
    acceptSpeechFinals.current = true;
    void speech.start();
  };

  const record = currentRecord(session);
  const sites = SURFACE_SITES[session.context.surface];
  const metrics = latencySummary(session.latencySamples);
  const completedSites = record.probingDepths.filter((value) => value !== null).length;
  const chartRows = useMemo(
    () => Object.values(session.charts)
      .filter((row) => row.updatedAt !== null || (row.tooth === session.context.tooth && row.surface === session.context.surface))
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

  const runExample = (transcript: string) => {
    const now = performance.now();
    commitTranscript(transcript, now, performance.now());
  };

  const changeContext = (patch: { tooth?: number; surface?: Surface }) => {
    dispatch({ type: 'context', patch, occurredAt: performance.now() });
  };

  const clearActiveRecord = () => {
    if (window.confirm(`Clear all values for tooth ${session.context.tooth}, ${session.context.surface}?`)) {
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
          <span className={`system-status ${speech.listening ? 'is-live' : ''}`} data-status={speech.status}>
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
              Speak naturally. Values are committed only when they fit the active three-site workflow;
              corrections replace data without shifting the sequence.
            </p>
          </div>
          <div className="trust-note">
            <ShieldCheck size={20} aria-hidden="true" />
            <span><strong>Prototype guardrail</strong>Out-of-range and overflow values are rejected atomically.</span>
          </div>
        </section>

        <div className="dashboard-grid">
          <section
            className="panel capture-panel"
            aria-labelledby="capture-title"
            aria-busy={speech.status === 'connecting' || speech.status === 'loading-model'}
          >
            <div className="panel-heading">
              <div>
                <p className="section-index">01 · CAPTURE</p>
                <h2 id="capture-title">Clinical voice stream</h2>
              </div>
              <span className={`mode-pill ${speech.listening ? 'is-live' : ''}`}>
                {speech.listening ? 'Live' : STATUS_LABELS[speech.status]}
              </span>
            </div>

            <div className="engine-card" aria-live="polite" data-status={speech.status}>
              <span className="engine-icon" aria-hidden="true">
                {speech.status === 'loading-model' || speech.status === 'connecting'
                  ? <LoaderCircle className="spin" size={19} />
                  : <Radio size={19} />}
              </span>
              <div>
                <span>Local recognition engine</span>
                <strong>{STATUS_LABELS[speech.status]}</strong>
                <small>
                  {speech.model
                    ? `${speech.model.name} · ${speech.model.device} / ${speech.model.computeType}`
                    : 'Faster-Whisper · private on-device processing'}
                  {speech.latestDecodeMs !== null ? ` · last decode ${speech.latestDecodeMs} ms` : ''}
                </small>
              </div>
              {(speech.status === 'offline' || speech.status === 'error') && speech.supported && (
                <button className="button button-quiet engine-retry" type="button" onClick={speech.retry}>
                  <RefreshCw size={16} aria-hidden="true" />
                  Retry engine
                </button>
              )}
            </div>

            <div
              className={`listening-stage ${speech.listening ? 'is-listening' : ''}`}
              style={{
                '--wave-speed': `${Math.max(420, 900 - speech.audioLevel * 480)}ms`,
              } as CSSProperties}
            >
              <div className="waveform" aria-hidden="true">
                {Array.from({ length: 18 }, (_, index) => <span key={index} />)}
              </div>
              <p className="interim-label">Live recognition</p>
              <p className="interim-copy" aria-live="polite">
                {speech.interimTranscript || (
                  speech.status === 'processing'
                    ? 'Recognizing utterance…'
                    : speech.listening
                      ? 'Listening for a clinical phrase…'
                      : speech.status === 'loading-model'
                        ? 'Preparing the local speech model…'
                        : 'Microphone is paused'
                )}
              </p>
              <button
                className={`button microphone-button ${speech.listening ? 'button-danger' : 'button-primary'}`}
                type="button"
                onClick={speech.listening ? speech.stop : startSpeech}
                disabled={!speech.listening && speech.status !== 'ready'}
                aria-label={speech.listening ? 'Stop microphone recognition' : 'Start microphone recognition'}
              >
                {speech.listening ? <MicOff size={20} aria-hidden="true" /> : <Mic size={20} aria-hidden="true" />}
                {speech.listening ? 'Stop listening' : 'Start listening'}
              </button>
            </div>

            {!speech.supported && (
              <div className="notice notice-info" role="status">
                <CircleAlert size={18} aria-hidden="true" />
                <span>Local microphone capture is unavailable here. The transcript simulator exercises the same clinical engine.</span>
              </div>
            )}
            {speech.error && (
              <div className="notice notice-error" role="alert">
                <CircleAlert size={18} aria-hidden="true" />
                <span>{speech.error}</span>
              </div>
            )}

            <form className="simulator" onSubmit={submitTranscript}>
              <label htmlFor="transcript-input">Transcript simulator</label>
              <div className="input-row">
                <input
                  id="transcript-input"
                  value={simulatedTranscript}
                  onChange={(event) => {
                    if (!event.target.value) simulatorStartedAt.current = null;
                    else if (simulatorStartedAt.current === null) simulatorStartedAt.current = performance.now();
                    setSimulatedTranscript(event.target.value);
                  }}
                  placeholder="Try: three four five"
                  autoComplete="off"
                />
                <button className="button button-primary" type="submit" disabled={!simulatedTranscript.trim()}>
                  <Sparkles size={18} aria-hidden="true" />
                  Process
                </button>
              </div>
              <p className="helper-text">Deterministic fallback for testing the same clinical parser without microphone audio.</p>
            </form>

            <div className="phrase-list" aria-label="Example clinical phrases">
              {EXAMPLE_PHRASES.map((phrase) => (
                <button key={phrase} type="button" onClick={() => runExample(phrase)}>
                  “{phrase}”
                </button>
              ))}
            </div>
          </section>

          <section className="panel chart-panel" aria-labelledby="chart-title">
            <div className="panel-heading">
              <div>
                <p className="section-index">02 · STRUCTURE</p>
                <h2 id="chart-title">Active periodontal chart</h2>
              </div>
              <span className="context-badge">Tooth {session.context.tooth}</span>
            </div>

            <fieldset className="context-controls">
              <legend>Clinical context</legend>
              <label>
                <span>Tooth</span>
                <select
                  aria-label="Current tooth"
                  value={session.context.tooth}
                  onChange={(event) => changeContext({ tooth: Number(event.target.value) })}
                >
                  {Array.from({ length: 32 }, (_, index) => index + 1).map((tooth) => (
                    <option key={tooth} value={tooth}>Tooth {tooth}</option>
                  ))}
                </select>
              </label>
              <div className="surface-control">
                <span>Surface</span>
                <div className="segmented-control">
                  {(['buccal', 'lingual'] as const).map((surface) => (
                    <button
                      key={surface}
                      type="button"
                      aria-pressed={session.context.surface === surface}
                      onClick={() => changeContext({ surface })}
                    >
                      {surface[0].toUpperCase() + surface.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </fieldset>

            <div className="sequence-status">
              <div>
                <span>Sequence position</span>
                <strong>{completedSites} of 3 sites recorded</strong>
              </div>
              <div className="progress-track" role="progressbar" aria-label="Three-site sequence completion" aria-valuemin={0} aria-valuemax={3} aria-valuenow={completedSites}>
                <span style={{ transform: `scaleX(${completedSites / 3})` }} />
              </div>
            </div>

            <div className="site-grid" aria-label={`Tooth ${record.tooth} ${record.surface} probing depths`}>
              {sites.map((site, index) => {
                const value = record.probingDepths[index];
                const isNext = session.context.position === index;
                return (
                  <article className={`site-card ${isNext ? 'is-next' : ''} ${value !== null ? 'has-value' : ''}`} key={site}>
                    <div className="site-card-label">
                      <span>{site}</span>
                      {value !== null && <Check size={16} aria-label="Recorded" />}
                    </div>
                    <strong aria-label={`${site} probing depth ${value ?? 'not recorded'}`}>
                      {value ?? '—'}
                    </strong>
                    <small>{value === null ? (isNext ? 'Listening next' : 'Pending') : 'millimeters'}</small>
                  </article>
                );
              })}
            </div>

            <div className="finding-row">
              <div>
                <span>Bleeding on probing</span>
                <small>Applies to active tooth and surface</small>
              </div>
              <span className={`finding-value ${record.bleeding === true ? 'is-positive' : record.bleeding === false ? 'is-negative' : ''}`}>
                {record.bleeding === null ? 'Not recorded' : record.bleeding ? 'Yes · present' : 'No · absent'}
              </span>
            </div>

            <button className="button button-quiet clear-button" type="button" onClick={clearActiveRecord}>
              <Trash2 size={17} aria-hidden="true" />
              Clear active record
            </button>
          </section>

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
            <p className="helper-text">Measured from detected speech start (or simulator input start) to structured chart commit.</p>
          </section>

          <section className="panel history-panel" aria-labelledby="history-title">
            <div className="panel-heading compact">
              <div>
                <p className="section-index">04 · AUDIT</p>
                <h2 id="history-title">Clinical event history</h2>
              </div>
              <History size={20} aria-hidden="true" />
            </div>
            <div className="event-list" aria-live="polite">
              {session.history.length === 0 ? (
                <div className="empty-state">
                  <ClipboardList size={24} aria-hidden="true" />
                  <span><strong>No chart events yet</strong>Use the microphone or simulator to begin.</span>
                </div>
              ) : session.history.slice(0, 8).map((event) => (
                <article className={`event event-${event.kind}`} key={event.id}>
                  <Activity size={17} aria-hidden="true" />
                  <div>
                    <span>{EVENT_LABELS[event.kind]}</span>
                    <strong>{event.message}</strong>
                    <small>“{event.transcript}”{event.latencyMs !== null ? ` · ${event.latencyMs} ms` : ''}</small>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>

        <section className="panel overview-panel" aria-labelledby="overview-title">
          <div className="panel-heading">
            <div>
              <p className="section-index">SESSION OVERVIEW</p>
              <h2 id="overview-title">Structured chart records</h2>
            </div>
            <span className="record-count">{chartRows.length} context{chartRows.length === 1 ? '' : 's'}</span>
          </div>
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">All periodontal measurements recorded in this session</caption>
              <thead><tr><th>Tooth</th><th>Surface</th><th>Site 1</th><th>Site 2</th><th>Site 3</th><th>Bleeding</th></tr></thead>
              <tbody>
                {chartRows.map((row) => (
                  <tr key={`${row.tooth}-${row.surface}`}>
                    <th scope="row">{row.tooth}</th>
                    <td>{row.surface}</td>
                    {row.probingDepths.map((value, index) => <td key={index}>{value ?? '—'}</td>)}
                    <td>{row.bleeding === null ? '—' : row.bleeding ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
