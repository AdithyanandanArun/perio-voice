import type { AsrWord, SpeakerVerdict, TranscriptTiming } from '../domain/types';

export const ASR_PROTOCOL_VERSION = 1;
export const TARGET_SAMPLE_RATE = 16_000;

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

/** Everything one finished utterance carries across the recognition boundary. */
export interface AsrFinal {
  transcript: string;
  timing: TranscriptTiming;
  words: AsrWord[];
  utteranceId: number | null;
  audioMs: number | null;
  decodeMs: number | null;
  speaker: SpeakerVerdict | null;
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
  decodeMs?: number;
  audioMs?: number;
  utteranceId?: number;
  startedAtMs?: number;
  endedAtMs?: number;
  droppedPartials?: number;
  words?: WordMessage[];
  speaker?: SpeakerMessage | null;
  engine?: string;
  unknownRatio?: number;
  noSpeechProb?: number;
  reason?: string;
  expect?: string;
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
