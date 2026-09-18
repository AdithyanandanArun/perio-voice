import { CircleAlert, LoaderCircle, Mic, MicOff, Radio, RefreshCw, Sparkles } from 'lucide-react';
import { type CSSProperties, type FormEvent } from 'react';
import { SpeakerPanel } from './SpeakerPanel';
import type { AsrStatus } from '../speech/protocol';
import type { LocalAsrController } from '../speech/useLocalAsr';

interface CapturePanelProps {
  speech: LocalAsrController;
  statusLabels: Record<AsrStatus, string>;
  examples: readonly string[];
  simulatedTranscript: string;
  onSimulatedChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onExample: (phrase: string) => void;
  onStart: () => void;
  showDeveloperTools?: boolean;
}

export function CapturePanel({
  speech,
  statusLabels,
  examples,
  simulatedTranscript,
  onSimulatedChange,
  onSubmit,
  onExample,
  onStart,
  showDeveloperTools = false,
}: CapturePanelProps) {
  return (
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
          {speech.listening ? 'Live' : statusLabels[speech.status]}
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
          <strong>{statusLabels[speech.status]}</strong>
          <small>
            {speech.model
              ? `${speech.model.name} · ${speech.model.device} / ${speech.model.computeType}`
              : 'Faster-Whisper · private on-device processing'}
            {speech.latestDecodeMs !== null ? ` · last decode ${speech.latestDecodeMs} ms` : ''}
          </small>
          {speech.runtime && (
            <small className="runtime-note">
              protocol v{speech.runtime.protocol} · prompt {speech.runtime.promptVersion} ·
              preprocessing {speech.runtime.denoiseProfile} · endpoint{' '}
              {speech.runtime.endSilenceMs} ms
            </small>
          )}
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
        style={{ '--wave-speed': `${Math.max(420, 900 - speech.audioLevel * 480)}ms` } as CSSProperties}
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
          onClick={speech.listening ? speech.stop : onStart}
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
          <span>
            Local microphone capture is unavailable here. The transcript simulator exercises the
            same clinical engine.
          </span>
        </div>
      )}
      {speech.error && (
        <div className="notice notice-error" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <span>{speech.error}</span>
        </div>
      )}

      <SpeakerPanel
        enrollment={speech.enrollment}
        verdict={speech.speaker}
        enrolling={speech.enrolling}
        supported={speech.supported}
        onEnroll={() => void speech.enroll()}
        onRevoke={() => void speech.revokeEnrollment()}
      />

      {showDeveloperTools && (
        <div className="developer-tools">
          <p className="developer-label">Development tools</p>
          <form className="simulator" onSubmit={onSubmit}>
            <label htmlFor="transcript-input">Transcript simulator</label>
            <textarea
              id="transcript-input"
              value={simulatedTranscript}
              onChange={(event) => onSimulatedChange(event.target.value)}
              placeholder="Try: three four five"
              autoComplete="off"
              rows={2}
              aria-describedby="auto-chart-help"
            />
            <div className="input-row">
              <button className="button button-primary" type="submit" disabled={!simulatedTranscript.trim()}>
                <Sparkles size={18} aria-hidden="true" /> Process
              </button>
            </div>
            <p className="helper-text" id="auto-chart-help">
              Use a normal phrase, or separate complete station directives with a semicolon or new
              line. Automatic batches require a tooth and surface in every directive.
            </p>
          </form>
          <div className="phrase-list" aria-label="Example clinical phrases">
            {examples.map((phrase) => (
              <button key={phrase} type="button" onClick={() => onExample(phrase)}>
                “{phrase}”
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
