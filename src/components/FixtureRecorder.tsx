import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import fixtureManifest from '../../evaluation/fixtures/dental/phrases.json';
import { captureSeconds, type CaptureSecondsOptions } from '../speech/capture';

type FixturePass = 'quiet' | 'noise';

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
}

interface FixtureRecorderProps {
  manifest?: DentalFixtureManifest;
  capture?: (seconds: number, options?: CaptureSecondsOptions) => Promise<Blob>;
  upload?: (request: UploadRequest) => Promise<void>;
}

type RecorderPhase = 'idle' | 'recording' | 'uploading' | 'error';

function durationForPrompt(prompt: string): number {
  const wordCount = prompt.trim().split(/\s+/).length;
  return Math.min(8, Math.max(2.5, 1.5 + wordCount * 0.55));
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'AbortError';
}

async function uploadFixture({ pass, id, pcm, signal }: UploadRequest): Promise<void> {
  const response = await fetch(
    `/api/fixture?pass=${encodeURIComponent(pass)}&id=${encodeURIComponent(id)}`,
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
  const [pending, setPending] = useState<{ item: QueueItem; pcm: Blob } | null>(null);
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
    if (!current || phase === 'recording' || phase === 'uploading') return;
    const controller = new AbortController();
    activeAbortRef.current?.abort();
    activeAbortRef.current = controller;
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
      setPending({ item: current, pcm });
      setPhase('uploading');
      await upload({ pass: current.pass, id: current.utterance.id, pcm, signal: controller.signal });
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
  }, [advanceAfterUpload, capture, current, phase, upload]);

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

      {complete ? (
        <div className="fixture-complete" role="status">
          Both passes are saved locally. Stop the capture-enabled service before reviewing metrics.
        </div>
      ) : current ? (
        <>
          <div className="fixture-pass" data-pass={current.pass}>
            <strong>{current.pass === 'quiet' ? 'Quiet-room pass' : 'Loudspeaker-noise pass'}</strong>
            <span>
              {current.pass === 'quiet'
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
            ) : (
              <button className="button button-primary" type="button" onClick={() => void record()} disabled={phase === 'recording' || phase === 'uploading'}>
                {phase === 'recording'
                  ? `Recording ${duration.toFixed(1)} seconds…`
                  : phase === 'error' ? 'Retry recording' : 'Record this prompt'}
              </button>
            )}
            {(phase === 'recording' || phase === 'uploading') && (
              <button className="button button-quiet" type="button" onClick={cancel}>Cancel</button>
            )}
          </div>

          <p className="fixture-status" aria-live="polite">
            {phase === 'idle' && `Ready for ${current.utterance.id}; recording lasts ${duration.toFixed(1)} seconds.`}
            {phase === 'recording' && 'Recording through the production PCM worklet…'}
            {phase === 'uploading' && 'Uploading PCM to the local fixture service…'}
            {phase === 'error' && error}
          </p>
        </>
      ) : null}
    </section>
  );
}
