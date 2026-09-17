import { TARGET_SAMPLE_RATE } from './protocol';

const MAX_CAPTURE_SECONDS = 30;

type AudioContextConstructor = typeof AudioContext;

declare global {
  interface Window {
    webkitAudioContext?: AudioContextConstructor;
  }
}

export interface CaptureSecondsOptions {
  /** Cancels a recording and releases its microphone and audio graph immediately. */
  signal?: AbortSignal;
  /** Receives the worklet RMS level while recording and a final zero on cleanup. */
  onLevel?: (level: number) => void;
}

function abortError(): DOMException {
  return new DOMException('Audio capture was cancelled.', 'AbortError');
}

function waitForDuration(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const finish = () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(abortError());
    };
    const timer = window.setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/**
 * Capture raw 16 kHz mono PCM16 through the same AudioWorklet path used by the
 * live recognizer. The returned blob has no container; callers choose whether
 * to stream the PCM or ask the local fixture service to wrap it as WAV.
 */
export async function captureSeconds(
  seconds: number,
  options: CaptureSecondsOptions = {},
): Promise<Blob> {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_CAPTURE_SECONDS) {
    throw new RangeError(`Capture duration must be greater than zero and at most ${MAX_CAPTURE_SECONDS} seconds.`);
  }
  if (options.signal?.aborted) throw abortError();
  if (typeof window === 'undefined' || typeof navigator === 'undefined'
      || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new Error('Microphone capture is unavailable.');
  }
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (!Context) throw new Error('AudioContext is unavailable.');

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let mute: GainNode | null = null;
  const chunks: ArrayBuffer[] = [];

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false },
    });
    if (options.signal?.aborted) throw abortError();

    context = new Context({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule('/audio/pcm-capture-worklet.js');
    if (options.signal?.aborted) throw abortError();

    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, 'pcm-capture-processor', {
      processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, batchMs: 100 },
    });
    mute = context.createGain();
    mute.gain.value = 0;
    worklet.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      chunks.push(event.data.pcm);
      options.onLevel?.(event.data.level);
    };
    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(context.destination);
    await context.resume();
    await waitForDuration(seconds * 1_000, options.signal);
    return new Blob(chunks, { type: 'application/octet-stream' });
  } finally {
    if (worklet) worklet.port.onmessage = null;
    try { source?.disconnect(); } catch { /* Already disconnected. */ }
    try { worklet?.disconnect(); } catch { /* Already disconnected. */ }
    try { mute?.disconnect(); } catch { /* Already disconnected. */ }
    for (const track of stream?.getTracks() ?? []) {
      try { track.stop(); } catch { /* A stopped track is already released. */ }
    }
    if (context) await context.close().catch(() => undefined);
    try { options.onLevel?.(0); } catch { /* Cleanup must not be masked by UI callbacks. */ }
  }
}
