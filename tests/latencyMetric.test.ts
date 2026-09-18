import { describe, expect, it } from 'vitest';
import { utteranceLatency } from '../src/domain/session';
import type { UtteranceInput } from '../src/domain/types';
import { responseWindowStart } from '../src/speech/useLocalAsr';

function input(startedAt: number, observedAt: number): UtteranceInput {
  return {
    transcript: 'three four five',
    words: [],
    timing: { startedAt, observedAt },
    source: 'asr',
    utteranceId: 1,
    audioMs: 1_800,
    decodeMs: 280,
    observedVersion: 1,
    speaker: null,
  };
}

describe('end-of-speech response metric', () => {
  it('measures from the last voiced frame rather than the start of the utterance', () => {
    const finalObservedAt = 4_200;
    const lastVoicedAt = 3_050;
    const origin = responseWindowStart(lastVoicedAt, 2_400, finalObservedAt);
    expect(utteranceLatency(input(origin, finalObservedAt))).toBe(1_150);
  });

  it('falls back to speech detection rather than under-reporting endpoint and transport time', () => {
    expect(responseWindowStart(null, 2_400, 4_200)).toBe(2_400);
    expect(responseWindowStart(null, null, 4_200)).toBe(4_200);
  });
});
