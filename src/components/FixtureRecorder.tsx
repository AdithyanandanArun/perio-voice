import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import fixtureManifest from '../../evaluation/fixtures/dental/phrases.json';
import { captureSeconds, type CaptureSecondsOptions } from '../speech/capture';
import {
  acousticReplaySupported,
  measurePcm16,
  MIN_REPLAY_RMS,
  playAcousticPrompt,
  replayVoiceLabel,
  TTS_REPLAY_SOURCE,
  type AcousticReplayRequest,
} from '../speech/acousticReplay';

type FixturePass = 'quiet' | 'noise';
type FixtureSource = 'human' | typeof TTS_REPLAY_SOURCE;

interface FixtureUtterance {
  id: string;
  prompt: string;
  chartable?: boolean;
}

interface FixtureScenario {
  id: string;
  cohort: string;
  note?: string;
  start?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  utterances: FixtureUtterance[];
  expect: Record<string, unknown>;
}

export interface DentalFixtureManifest {
  schemaVersion: number;
  fixtureVersion: string;
  sourceCorpusVersion?: string;
  sampleRate: number;
  passes: FixturePass[];
  scenarios: FixtureScenario[];
}

interface QueueItem {
  pass: FixturePass;
  scenario: FixtureScenario;
  utterance: FixtureUtterance;
}

interface UploadRequest {
  pass: FixturePass;
  id: string;
  pcm: Blob;
  signal: AbortSignal;
  source: FixtureSource;
}

interface FixtureRecorderProps {
  manifest?: DentalFixtureManifest;
  capture?: (seconds: number, options?: CaptureSecondsOptions) => Promise<Blob>;
  upload?: (request: UploadRequest) => Promise<void>;
  replay?: (request: AcousticReplayRequest) => Promise<void>;
  replayAvailable?: boolean;
}

type RecorderPhase = 'idle' | 'recording' | 'uploading' | 'error';

function durationForPrompt(prompt: string): number {
  const wordCount = prompt.trim().split(/\s+/).length;
  return Math.min(8, Math.max(2.5, 1.5 + wordCount * 0.55));
}

function isAbortError(reason: unknown): boolean {
  return typeof reason === 'object'
    && reason !== null
    && 'name' in reason
    && reason.name === 'AbortError';
}

async function uploadFixture({ pass, id, pcm, signal, source }: UploadRequest): Promise<void> {
  const sourceParameter = source === TTS_REPLAY_SOURCE ? `&source=${TTS_REPLAY_SOURCE}` : '';
  const response = await fetch(
    `/api/fixture?pass=${encodeURIComponent(pass)}&id=${encodeURIComponent(id)}${sourceParameter}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pcm,
      signal,
    },
  );
  if (response.ok) return;
  let detail = `Upload failed with HTTP ${response.status}.`;
  try {
    const payload = (await response.json()) as { detail?: string };
    if (payload.detail) detail = payload.detail;
  } catch {
    // Keep the status-only message when a proxy returns a non-JSON error page.
  }
  throw new Error(detail);
}

export function FixtureRecorder({
  manifest = fixtureManifest as DentalFixtureManifest,
  capture = captureSeconds,
  upload = uploadFixture,
  replay = playAcousticPrompt,
  replayAvailable = acousticReplaySupported(),
}: FixtureRecorderProps) {
  const queue = useMemo<QueueItem[]>(() => manifest.passes.flatMap((pass) =>
    manifest.scenarios.flatMap((scenario) => scenario.utterances.map((utterance) => ({
      pass,
      scenario,
      utterance,
    })))), [manifest]);
  const [position, setPosition] = useState(0);
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    item: QueueItem;
    pcm: Blob;
    source: FixtureSource;
  } | null>(null);
  const [sessionSource, setSessionSource] = useState<FixtureSource | null>(null);
  const [replayRunning, setReplayRunning] = useState(false);
  const activeAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const current = queue[position];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
    };
  }, []);

  const advanceAfterUpload = useCallback(() => {
    if (!mountedRef.current) return;
    setPending(null);
    setError(null);
    setLevel(0);
    setPosition((value) => value + 1);
    setPhase('idle');
  }, []);

  const record = useCallback(async () => {
    if (!current || replayRunning || sessionSource === TTS_REPLAY_SOURCE
        || phase === 'recording' || phase === 'uploading') return;
    const controller = new AbortController();
    activeAbortRef.current?.abort();
    activeAbortRef.current = controller;
    setSessionSource('human');
    setPending(null);
    setError(null);
    setPhase('recording');
    let pcm: Blob | null = null;
    try {
      pcm = await capture(durationForPrompt(current.utterance.prompt), {
        signal: controller.signal,
        onLevel: (value) => {
          if (mountedRef.current) setLevel(Math.min(1, value * 4));
        },
      });
      if (pcm.size === 0) throw new Error('No PCM samples were captured. Check the microphone and retry.');
      if (!mountedRef.current) return;
      setPending({ item: current, pcm, source: 'human' });
      setPhase('uploading');
      await upload({
        pass: current.pass,
        id: current.utterance.id,
        pcm,
        signal: controller.signal,
        source: 'human',
      });
      advanceAfterUpload();
    } catch (reason) {
      if (!mountedRef.current) return;
      if (isAbortError(reason)) {
        setError(pcm ? 'Upload cancelled. Retry keeps the captured clip.' : 'Recording cancelled.');
      } else {
        const detail = reason instanceof Error ? reason.message : 'Unknown capture failure.';
        setError(detail);
      }
      setLevel(0);
      setPhase('error');
    } finally {
      if (activeAbortRef.current === controller) activeAbortRef.current = null;
    }
  }, [advanceAfterUpload, capture, current, phase, replayRunning, sessionSource, upload]);

  const retryUpload = useCallback(async () => {
    if (!pending || phase === 'recording' || phase === 'uploading') return;
    const controller = new AbortController();
    activeAbortRef.current?.abort();
    activeAbortRef.current = controller;
    setError(null);
    setPhase('uploading');
    try {
      await upload({
        pass: pending.item.pass,
        id: pending.item.utterance.id,
        pcm: pending.pcm,
        signal: controller.signal,
        source: pending.source,
      });
      advanceAfterUpload();
    } catch (reason) {
      if (!mountedRef.current) return;
      const detail = isAbortError(reason)
        ? 'Upload cancelled. Retry keeps the captured clip.'
        : reason instanceof Error ? reason.message : 'Unknown upload failure.';
      setError(detail);
      setPhase('error');
    } finally {
      if (activeAbortRef.current === controller) activeAbortRef.current = null;
    }
  }, [advanceAfterUpload, pending, phase, upload]);

  const replayRemaining = useCallback(async () => {
    if (!replayAvailable || replayRunning || sessionSource === 'human'
        || phase === 'recording' || phase === 'uploading' || position >= queue.length) return;

    const controller = new AbortController();
    activeAbortRef.current?.abort();
    activeAbortRef.current = controller;
    setSessionSource(TTS_REPLAY_SOURCE);
    setReplayRunning(true);
    setPending(null);
    setError(null);

    try {
      for (let index = position; index < queue.length; index += 1) {
        if (controller.signal.aborted) throw new DOMException('cancelled', 'AbortError');
        const item = queue[index];
        if (!mountedRef.current) return;
        setPosition(index);
        setPhase('recording');
        setLevel(0);

        let playbackStarted = false;
        let startPlayback: () => void = () => undefined;
        const playbackFinished = new Promise<void>((resolve, reject) => {
          startPlayback = () => {
            if (playbackStarted) return;
            playbackStarted = true;
            void replay({
              utteranceId: item.utterance.id,
              prompt: item.utterance.prompt,
              noisy: item.pass === 'noise',
              signal: controller.signal,
            }).then(resolve, reject);
          };
        });
        const capturePromise = capture(durationForPrompt(item.utterance.prompt), {
          signal: controller.signal,
          profile: 'loudspeaker-replay',
          onReady: startPlayback,
          onLevel: (value) => {
            if (mountedRef.current) setLevel(Math.min(1, value * 4));
          },
        });

        let pcm: Blob;
        try {
          [pcm] = await Promise.all([capturePromise, playbackFinished]);
        } catch (reason) {
          controller.abort();
          throw reason;
        }
        if (pcm.size === 0) {
          throw new Error('No PCM samples were captured. Check the microphone and retry.');
        }
        const recordedLevel = await measurePcm16(pcm);
        if (recordedLevel.rms < MIN_REPLAY_RMS) {
          throw new Error(
            `The loudspeaker replay was inaudible to the microphone (RMS ${recordedLevel.rms.toFixed(4)}). `
            + 'Raise the laptop speaker volume, keep the microphone unobstructed, and resume.',
          );
        }

        if (!mountedRef.current) return;
        setPending({ item, pcm, source: TTS_REPLAY_SOURCE });
        setPhase('uploading');
        await upload({
          pass: item.pass,
          id: item.utterance.id,
          pcm,
          signal: controller.signal,
          source: TTS_REPLAY_SOURCE,
        });
        if (!mountedRef.current) return;
        setPending(null);
        setPosition(index + 1);
      }
      if (mountedRef.current) {
        setLevel(0);
        setPhase('idle');
      }
    } catch (reason) {
      if (!mountedRef.current) return;
      const detail = isAbortError(reason)
        ? 'Automated replay paused. Resume to retry the current phrase.'
        : reason instanceof Error ? reason.message : 'Unknown acoustic replay failure.';
      setError(detail);
      setLevel(0);
      setPhase('error');
    } finally {
      if (mountedRef.current) setReplayRunning(false);
      if (activeAbortRef.current === controller) activeAbortRef.current = null;
    }
  }, [capture, phase, position, queue, replay, replayAvailable, replayRunning, sessionSource, upload]);

  const cancel = () => activeAbortRef.current?.abort();
  const complete = position >= queue.length;
  const passPosition = current
    ? manifest.passes.indexOf(current.pass) + 1
    : manifest.passes.length;
  const duration = current ? durationForPrompt(current.utterance.prompt) : 0;

  return (
    <section className="panel fixture-recorder" aria-labelledby="fixture-recorder-title">
      <div className="panel-heading fixture-heading">
        <div>
          <p className="section-index">Private developer tool</p>
          <h2 id="fixture-recorder-title">Dental speech fixture recorder</h2>
        </div>
        <span className="mode-pill">v{manifest.fixtureVersion}</span>
      </div>

      <div className="fixture-privacy" role="note">
        Audio is sent only to the opted-in local fixture route and saved under a git-ignored
        directory. Never record a patient or include identifying information.
      </div>

      <div className="fixture-progress">
        <div>
          <strong>{complete ? 'Capture complete' : `${position} of ${queue.length} clips saved`}</strong>
          <span>{manifest.sampleRate.toLocaleString()} Hz mono PCM · pass {passPosition} of {manifest.passes.length}</span>
        </div>
        <progress value={position} max={queue.length || 1} aria-label="Fixture capture progress" />
      </div>

      {!complete && (
        <div className="fixture-automation" aria-labelledby="fixture-automation-title">
          <div>
            <span className="fixture-method">Hands-free acoustic fixture</span>
            <h3 id="fixture-automation-title">Replay every prompt through this laptop</h3>
            <p>
              The pinned local Piper voice plays from the speakers while the production PCM worklet
              records the microphone. The noise pass adds a repeatable synthetic suction and
              handpiece bed. Human fixture files are kept separate and never overwritten.
            </p>
            <dl>
              <div><dt>Voice</dt><dd>{replayVoiceLabel()}</dd></div>
              <div><dt>Output</dt><dd>audio/tts-replay/</dd></div>
            </dl>
          </div>
          <div className="fixture-automation-action">
            <button
              className="button button-primary"
              type="button"
              onClick={() => void replayRemaining()}
              disabled={!replayAvailable || replayRunning || sessionSource === 'human'
                || pending !== null || phase === 'recording' || phase === 'uploading'}
            >
              {replayRunning
                ? `Replaying clip ${position + 1} of ${queue.length}…`
                : sessionSource === TTS_REPLAY_SOURCE
                  ? `Resume remaining ${queue.length - position} clips`
                  : `Record all ${queue.length} with Piper TTS`}
            </button>
            <small aria-live="polite">
              {!replayAvailable
                ? 'This browser does not expose the media playback and Web Audio APIs required for local Piper replay.'
                : sessionSource === 'human'
                  ? 'Reload the page to choose TTS; capture modes cannot be mixed.'
                  : 'Set speaker volume to a normal conversational level before starting.'}
            </small>
          </div>
        </div>
      )}

      {complete ? (
        <div className="fixture-complete" role="status">
          {sessionSource === TTS_REPLAY_SOURCE
            ? 'Both TTS loudspeaker passes are saved under audio/tts-replay. Stop the capture-enabled service, then evaluate that audio root.'
            : 'Both human passes are saved locally. Stop the capture-enabled service before reviewing metrics.'}
        </div>
      ) : current ? (
        <>
          <div className="fixture-pass" data-pass={current.pass}>
            <strong>{current.pass === 'quiet' ? 'Quiet-room pass' : 'Loudspeaker-noise pass'}</strong>
            <span>
              {sessionSource === TTS_REPLAY_SOURCE
                ? current.pass === 'quiet'
                  ? 'The local Piper voice plays alone through the laptop speakers.'
                  : 'The local Piper voice plays with deterministic synthetic operatory noise.'
                : current.pass === 'quiet'
                  ? 'Use a quiet room and your normal clinical charting voice.'
                  : 'Play non-identifying operatory noise from a loudspeaker while the clinician reads. Never include live patient or bystander speech.'}
            </span>
          </div>

          <div className="fixture-prompt">
            <div>
              <span>{current.scenario.cohort} · {current.scenario.id}</span>
              {current.utterance.chartable === false && <em>non-chartable control</em>}
            </div>
            <blockquote>{current.utterance.prompt}</blockquote>
            {current.scenario.note && <p>{current.scenario.note}</p>}
          </div>

          <div
            className="fixture-meter"
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(level * 100)}
          >
            <span style={{ transform: `scaleX(${level})` }} />
          </div>

          <div className="fixture-actions">
            {pending ? (
              <button className="button button-primary" type="button" onClick={() => void retryUpload()} disabled={phase === 'uploading'}>
                {phase === 'uploading' ? 'Uploading…' : 'Retry upload'}
              </button>
            ) : sessionSource !== TTS_REPLAY_SOURCE ? (
              <button className="button button-primary" type="button" onClick={() => void record()} disabled={phase === 'recording' || phase === 'uploading'}>
                {phase === 'recording'
                  ? `Recording ${duration.toFixed(1)} seconds…`
                  : phase === 'error' ? 'Retry recording' : 'Record this prompt'}
              </button>
            ) : null}
            {(phase === 'recording' || phase === 'uploading') && (
              <button className="button button-quiet" type="button" onClick={cancel}>Cancel</button>
            )}
          </div>

          <p className="fixture-status" aria-live="polite">
            {phase === 'idle' && (sessionSource === TTS_REPLAY_SOURCE
              ? `Ready to replay ${current.utterance.id}; microphone capture lasts ${duration.toFixed(1)} seconds.`
              : `Ready for ${current.utterance.id}; recording lasts ${duration.toFixed(1)} seconds.`)}
            {phase === 'recording' && (sessionSource === TTS_REPLAY_SOURCE
              ? `Playing ${current.pass === 'noise' ? 'Piper TTS plus synthetic operatory noise' : 'local Piper TTS'} through the speakers while recording the microphone…`
              : 'Recording through the production PCM worklet…')}
            {phase === 'uploading' && `Uploading ${sessionSource === TTS_REPLAY_SOURCE ? 'isolated TTS replay' : 'human'} PCM to the local fixture service…`}
            {phase === 'error' && error}
          </p>
        </>
      ) : null}
    </section>
  );
}
