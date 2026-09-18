import type {
  AsrWord,
  RecognitionAlternative,
  SpeakerVerdict,
  TranscriptTiming,
} from '../domain/types';

/**
 * Microphone constraints for recognition.
 *
 * The browser's own speech processing is off on purpose. Noise suppression and
 * automatic gain control are tuned for voice calls, where the listener is a
 * person who tolerates artefacts: they gate low-energy speech and pump levels
 * between utterances. Both behaviours damage exactly what this product depends
 * on — short, quiet, fricative-initial words like "three" and "five" — and they
 * do it before any code here can see the audio, which is why no file-based
 * benchmark in this repository can detect the damage.
 *
 * Echo cancellation stays on: it needs a far-end reference to do anything, so
 * with no playback it is inert, and it is what stops the machine's own audio
 * being transcribed if that ever changes.
 */
export const CAPTURE_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

export const ASR_PROTOCOL_VERSION = 1;
export const TARGET_SAMPLE_RATE = 16_000;
/**
 * Live capture deliberately uses a small, fixed batch. 40 ms keeps transport
 * overhead below the 20 ms option while cutting the old 100 ms capture floor
 * by more than half. The worklet still accepts an explicit batch size for
 * offline/fixture callers and backwards-compatible tests.
 */
export const LIVE_BATCH_MS = 40;
export const LIVE_BATCH_SAMPLES = TARGET_SAMPLE_RATE * LIVE_BATCH_MS / 1_000;
/** Non-live enrollment and fixture recordings retain the established cadence. */
export const CAPTURE_BATCH_MS = 100;
/**
 * A browser WebSocket has no application-level backpressure callback. Keep at
 * most three live batches in its native send buffer; once that bound is hit,
 * the capture thread continues and the dropped sample range is reported by an
 * ordered `audio_gap` control rather than allowing an unbounded PCM backlog.
 */
export const MAX_BUFFERED_AUDIO_BYTES = LIVE_BATCH_SAMPLES * Int16Array.BYTES_PER_ELEMENT * 3;

export interface AudioGapControl {
  type: 'audio_gap';
  streamId: string;
  sampleRate: number;
  startSample: number;
  endSample: number;
}

export function createAudioGapControl(
  streamId: string,
  startSample: number,
  endSample: number,
): AudioGapControl {
  return {
    type: 'audio_gap',
    streamId,
    sampleRate: TARGET_SAMPLE_RATE,
    startSample,
    endSample,
  };
}

export type AsrStatus =
  | 'unsupported'
  | 'offline'
  | 'connecting'
  | 'loading-model'
  | 'ready'
  | 'listening'
  | 'processing'
  | 'error';

export interface AsrModelInfo {
  name: string;
  device: string;
  computeType: string;
}

/** Endpoint pacing the service reports back after each finished utterance. */
export interface CadenceInfo {
  endSilenceMs: number;
  wordsPerSecond: number;
  pauseP90Ms: number;
  samples: number;
  adaptive: boolean;
}

export interface EnrollmentState {
  enrolled: boolean;
  samples: number;
  voicedMs: number;
}

/** What the clinical context is waiting for, which selects the recognizer grammar. */
export type ClinicalExpectation = 'depths' | 'tooth' | 'findings' | 'commands' | 'clinical' | 'free';

export interface RuntimeInfo {
  protocol: number;
  promptVersion: string;
  biasPrompt: boolean;
  denoiseProfile: string;
  endSilenceMs: number;
  endpointBandMs: [number, number];
  cadenceAdaptive: boolean;
  engine?: string;
}

export type AsrLifecycle = 'provisional' | 'confirmed' | 'corrected' | 'held';

/** The recognizer path is intentionally open-ended for additive server paths. */
export type RecognitionPath = string;

/**
 * Timing relative to the captured PCM stream. These offsets are not wall-clock
 * values and must never be populated from the server's monotonic timestamps.
 */
export interface AsrSampleTiming {
  sampleRate: number | null;
  startSample: number | null;
  endSample: number | null;
  durationSamples: number | null;
}

export type AsrTiming = TranscriptTiming & AsrSampleTiming;

export interface AsrIdentity {
  streamId: string | null;
  utteranceId: number | null;
  transactionId: string | null;
  revision: number;
  originalContextVersion: number | null;
}

export interface AsrPartial extends AsrIdentity {
  transcript: string;
  timing: AsrTiming;
  lifecycle: AsrLifecycle;
  recognitionPath: RecognitionPath | null;
  audioMs: number | null;
  decodeMs: number | null;
}

export interface AsrEndpoint extends AsrIdentity {
  timing: AsrTiming;
  lifecycle: AsrLifecycle;
  recognitionPath: RecognitionPath | null;
  audioMs: number | null;
}

/** Everything one finished utterance carries across the recognition boundary. */
export interface AsrFinal {
  alternatives: RecognitionAlternative[];
  transcript: string;
  timing: AsrTiming;
  words: AsrWord[];
  streamId: string | null;
  utteranceId: number | null;
  transactionId: string | null;
  revision: number;
  originalContextVersion: number | null;
  lifecycle: AsrLifecycle;
  recognitionPath: RecognitionPath | null;
  audioMs: number | null;
  decodeMs: number | null;
  speaker: SpeakerVerdict | null;
  /** Kept as the established name used by the clinical pipeline. */
  observedVersion: number | null;
}

interface WordMessage {
  word?: string;
  startMs?: number;
  endMs?: number;
  probability?: number;
}

interface SpeakerMessage {
  decision?: string;
  similarity?: number;
  enrolled?: boolean;
  voicedMs?: number;
}

export interface AsrServerMessage {
  type: string;
  protocol?: number;
  status?: string;
  model?: string;
  device?: string;
  computeType?: string;
  text?: string;
  streamId?: string | null;
  transactionId?: string | null;
  revision?: number | null;
  originalContextVersion?: number | null;
  contextVersion?: number | null;
  lifecycle?: string;
  recognitionPath?: string | null;
  path?: string | null;
  decodeMs?: number;
  audioMs?: number;
  utteranceId?: number | null;
  startedAtMs?: number;
  endedAtMs?: number;
  sampleRate?: number;
  startSample?: number;
  endSample?: number;
  durationSamples?: number;
  endpoint?: boolean;
  droppedPartials?: number;
  words?: WordMessage[];
  speaker?: SpeakerMessage | null;
  engine?: string;
  unknownRatio?: number;
  noSpeechProb?: number;
  reason?: string;
  expect?: string;
  alternatives?: { text?: string; confidence?: number }[];
  cadence?: Partial<CadenceInfo> | null;
  error?: string | null;
  message?: string;
  recoverable?: boolean;
}

export function asrWebSocketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws/asr`;
}

export function parseServerMessage(value: string): AsrServerMessage | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return null;
    return parsed as AsrServerMessage;
  } catch {
    return null;
  }
}

export function readWords(message: AsrServerMessage): AsrWord[] {
  if (!Array.isArray(message.words)) return [];
  return message.words
    .filter((word): word is Required<WordMessage> =>
      typeof word.word === 'string'
      && typeof word.startMs === 'number'
      && typeof word.endMs === 'number'
      && typeof word.probability === 'number')
    .map((word) => ({
      word: word.word,
      startMs: word.startMs,
      endMs: word.endMs,
      probability: word.probability,
    }));
}

const DECISIONS = new Set(['clinician', 'other', 'unknown']);

export function readSpeaker(message: AsrServerMessage): SpeakerVerdict | null {
  const speaker = message.speaker;
  if (!speaker || typeof speaker.decision !== 'string' || !DECISIONS.has(speaker.decision)) {
    return null;
  }
  return {
    decision: speaker.decision as SpeakerVerdict['decision'],
    similarity: typeof speaker.similarity === 'number' ? speaker.similarity : 0,
    overridden: false,
  };
}

export function readAlternatives(message: AsrServerMessage): RecognitionAlternative[] {
  if (!Array.isArray(message.alternatives)) return [];
  return message.alternatives
    .filter((entry): entry is { text: string; confidence?: number } =>
      typeof entry?.text === 'string' && entry.text.trim() !== '')
    .map((entry) => ({ text: entry.text.trim(), confidence: entry.confidence ?? 0 }));
}

export function readCadence(message: AsrServerMessage): CadenceInfo | null {
  const cadence = message.cadence;
  if (!cadence || typeof cadence.endSilenceMs !== 'number') return null;
  return {
    endSilenceMs: cadence.endSilenceMs,
    wordsPerSecond: cadence.wordsPerSecond ?? 0,
    pauseP90Ms: cadence.pauseP90Ms ?? 0,
    samples: cadence.samples ?? 0,
    adaptive: cadence.adaptive ?? false,
  };
}

const LIFECYCLES = new Set<AsrLifecycle>([
  'provisional',
  'confirmed',
  'corrected',
  'held',
]);

export function readLifecycle(
  message: AsrServerMessage,
  fallback: AsrLifecycle,
): AsrLifecycle {
  return typeof message.lifecycle === 'string' && LIFECYCLES.has(message.lifecycle as AsrLifecycle)
    ? message.lifecycle as AsrLifecycle
    : fallback;
}

export function readRecognitionPath(message: AsrServerMessage): RecognitionPath | null {
  const path = message.recognitionPath ?? message.path ?? message.engine;
  return typeof path === 'string' && path.trim() !== '' ? path.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

export function readOriginalContextVersion(message: AsrServerMessage): number | null {
  return finiteNumber(message.originalContextVersion) ?? finiteNumber(message.contextVersion);
}

export function readSampleTiming(message: AsrServerMessage): AsrSampleTiming {
  const startSample = nonNegativeNumber(message.startSample);
  const endSample = nonNegativeNumber(message.endSample);
  const explicitDuration = nonNegativeNumber(message.durationSamples);
  const inferredDuration = startSample !== null && endSample !== null && endSample >= startSample
    ? endSample - startSample
    : null;
  const durationSamples = explicitDuration ?? inferredDuration;
  const sampleRateValue = finiteNumber(message.sampleRate);
  const sampleRate = sampleRateValue !== null && sampleRateValue > 0 ? sampleRateValue : null;
  const resolvedSampleRate = sampleRate
    ?? (startSample !== null || endSample !== null || durationSamples !== null
      ? TARGET_SAMPLE_RATE
      : null);
  return {
    sampleRate: resolvedSampleRate,
    startSample,
    endSample,
    durationSamples,
  };
}
