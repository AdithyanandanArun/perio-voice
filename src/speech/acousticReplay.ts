const REPLAY_RATE = 0.92;
const MAX_REPLAY_MS = 15_000;

export const TTS_REPLAY_SOURCE = 'tts-replay' as const;
export const MIN_REPLAY_RMS = 0.002;

export interface AcousticReplayRequest {
  utteranceId: string;
  prompt: string;
  noisy: boolean;
  signal: AbortSignal;
}

export interface PcmLevel {
  rms: number;
  peak: number;
}

interface NoiseBed {
  stop: () => Promise<void>;
}

function abortError(): DOMException {
  return new DOMException('Acoustic replay was cancelled.', 'AbortError');
}

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext ?? window.webkitAudioContext;
}

/** The replay is deliberately local: checked-in Piper audio never reaches a TTS service. */
export function acousticReplaySupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.Audio === 'function'
    && typeof audioContextConstructor() === 'function';
}

export function replayVoiceLabel(): string {
  return acousticReplaySupported() ? 'Piper en_US-lessac-medium' : 'Unavailable';
}

function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('Could not read captured PCM bytes.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read captured PCM bytes.'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Measure raw little-endian mono PCM16 without trusting a UI level callback. */
export async function measurePcm16(pcm: Blob): Promise<PcmLevel> {
  const bytes = await readBlobBytes(pcm);
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) return { rms: 0, peak: 0 };
  const samples = new DataView(bytes);
  let sumSquares = 0;
  let peak = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    const value = samples.getInt16(offset, true) / 32_768;
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  return {
    rms: Math.sqrt(sumSquares / (bytes.byteLength / 2)),
    peak,
  };
}

async function startOperatoryNoise(signal: AbortSignal): Promise<NoiseBed> {
  const Context = audioContextConstructor();
  if (!Context) throw new Error('AudioContext is unavailable for the noise pass.');
  if (signal.aborted) throw abortError();

  const context = new Context({ latencyHint: 'interactive' });
  const seconds = 2;
  const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
  const samples = buffer.getChannelData(0);
  // A fixed seed keeps the speaker stimulus repeatable across clips and runs.
  let state = 0x51f15e;
  for (let index = 0; index < samples.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    samples[index] = (state / 0xffff_ffff) * 2 - 1;
  }

  const suction = context.createBufferSource();
  suction.buffer = buffer;
  suction.loop = true;
  const suctionBand = context.createBiquadFilter();
  suctionBand.type = 'bandpass';
  suctionBand.frequency.value = 2_400;
  suctionBand.Q.value = 0.55;
  const suctionGain = context.createGain();
  suctionGain.gain.value = 0.055;

  const handpiece = context.createOscillator();
  handpiece.type = 'sawtooth';
  handpiece.frequency.value = 4_600;
  const handpieceGain = context.createGain();
  handpieceGain.gain.value = 0.012;

  suction.connect(suctionBand);
  suctionBand.connect(suctionGain);
  suctionGain.connect(context.destination);
  handpiece.connect(handpieceGain);
  handpieceGain.connect(context.destination);
  await context.resume();
  if (signal.aborted) {
    await context.close().catch(() => undefined);
    throw abortError();
  }
  suction.start();
  handpiece.start();

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try { suction.stop(); } catch { /* A completed source is already stopped. */ }
      try { handpiece.stop(); } catch { /* A completed oscillator is already stopped. */ }
      try { suction.disconnect(); } catch { /* The graph may already be closed. */ }
      try { suctionBand.disconnect(); } catch { /* The graph may already be closed. */ }
      try { suctionGain.disconnect(); } catch { /* The graph may already be closed. */ }
      try { handpiece.disconnect(); } catch { /* The graph may already be closed. */ }
      try { handpieceGain.disconnect(); } catch { /* The graph may already be closed. */ }
      await context.close().catch(() => undefined);
    },
  };
}

/**
 * Play one Piper-rendered fixture phrase through the laptop output. During the
 * noise pass a deterministic suction/handpiece bed is emitted beside the voice.
 * The caller starts this only after microphone capture reports that its worklet
 * is live, preventing the beginning of short words from being clipped.
 */
export function playAcousticPrompt({
  utteranceId,
  prompt,
  noisy,
  signal,
}: AcousticReplayRequest): Promise<void> {
  if (!acousticReplaySupported()) {
    return Promise.reject(new Error('Local Piper replay is unavailable in this browser.'));
  }
  if (signal.aborted) return Promise.reject(abortError());

  const stimulus = new window.Audio(
    `/api/fixture/tts?id=${encodeURIComponent(utteranceId)}`,
  );
  stimulus.preload = 'auto';
  stimulus.volume = 1;
  stimulus.playbackRate = REPLAY_RATE;

  return new Promise((resolve, reject) => {
    let settled = false;
    let noise: NoiseBed | null = null;
    const timeoutMs = Math.min(
      MAX_REPLAY_MS,
      Math.max(6_000, prompt.trim().split(/\s+/).length * 1_200),
    );
    const timeout = window.setTimeout(() => {
      stimulus.pause();
      void settle(new Error('The local Piper stimulus did not finish playing. Check audio output and retry.'));
    }, timeoutMs);

    const settle = async (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      stimulus.onended = null;
      stimulus.onerror = null;
      await noise?.stop();
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => {
      stimulus.pause();
      stimulus.currentTime = 0;
      void settle(abortError());
    };

    signal.addEventListener('abort', cancel, { once: true });
    stimulus.onended = () => void settle();
    stimulus.onerror = () => {
      const detail = stimulus.error?.message || 'unknown media error';
      void settle(new Error(`Could not play the local Piper stimulus (${detail}).`));
    };

    void (async () => {
      try {
        if (noisy) noise = await startOperatoryNoise(signal);
        if (signal.aborted) throw abortError();
        await stimulus.play();
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error('Could not start acoustic replay.');
        await settle(error);
      }
    })();
  });
}
