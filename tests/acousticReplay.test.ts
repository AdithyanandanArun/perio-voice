import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acousticReplaySupported,
  measurePcm16,
  playAcousticPrompt,
  replayVoiceLabel,
} from '../src/speech/acousticReplay';

const node = () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
});

class MockReplayAudioContext {
  static instances: MockReplayAudioContext[] = [];
  sampleRate = 100;
  destination = {} as AudioDestinationNode;
  close = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockResolvedValue(undefined);
  source = { ...node(), buffer: null, loop: false };
  filter = { ...node(), type: 'lowpass', frequency: { value: 0 }, Q: { value: 0 } };
  gain = { ...node(), gain: { value: 0 } };
  oscillator = { ...node(), type: 'sine', frequency: { value: 0 } };

  constructor() {
    MockReplayAudioContext.instances.push(this);
  }

  createBuffer() {
    const samples = new Float32Array(this.sampleRate * 2);
    return { getChannelData: () => samples } as unknown as AudioBuffer;
  }

  createBufferSource() {
    return this.source as unknown as AudioBufferSourceNode;
  }

  createBiquadFilter() {
    return this.filter as unknown as BiquadFilterNode;
  }

  createGain() {
    return this.gain as unknown as GainNode;
  }

  createOscillator() {
    return this.oscillator as unknown as OscillatorNode;
  }
}

let finishPlayback = true;

class MockAudio {
  static instances: MockAudio[] = [];
  preload = '';
  volume = 0;
  playbackRate = 1;
  currentTime = 0;
  error: MediaError | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(async () => {
    if (finishPlayback) queueMicrotask(() => this.onended?.());
  });

  constructor(public readonly src: string) {
    MockAudio.instances.push(this);
  }
}

function installReplayEnvironment(autoFinish = true) {
  finishPlayback = autoFinish;
  MockAudio.instances = [];
  vi.stubGlobal('Audio', MockAudio);
  vi.stubGlobal('AudioContext', MockReplayAudioContext);
}

beforeEach(() => {
  MockReplayAudioContext.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local acoustic replay', () => {
  it('plays the exact checked-in Piper stimulus without a noise graph on the quiet pass', async () => {
    installReplayEnvironment();
    expect(acousticReplaySupported()).toBe(true);
    expect(replayVoiceLabel()).toBe('Piper en_US-lessac-medium');

    await playAcousticPrompt({
      utteranceId: 'clean-depths-u01',
      prompt: 'three four five',
      noisy: false,
      signal: new AbortController().signal,
    });

    const stimulus = MockAudio.instances[0];
    expect(stimulus.src).toBe('/api/fixture/tts?id=clean-depths-u01');
    expect(stimulus).toMatchObject({ preload: 'auto', volume: 1, playbackRate: 0.92 });
    expect(stimulus.play).toHaveBeenCalledOnce();
    expect(MockReplayAudioContext.instances).toHaveLength(0);
  });

  it('encodes fixture ids and adds a deterministic operatory-noise graph only for the noise pass', async () => {
    installReplayEnvironment();
    await playAcousticPrompt({
      utteranceId: 'finding/unsafe id',
      prompt: 'bleeding',
      noisy: true,
      signal: new AbortController().signal,
    });

    expect(MockAudio.instances[0].src).toBe('/api/fixture/tts?id=finding%2Funsafe%20id');
    const context = MockReplayAudioContext.instances[0];
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.source.start).toHaveBeenCalledOnce();
    expect(context.oscillator.start).toHaveBeenCalledOnce();
    expect(context.filter).toMatchObject({
      type: 'bandpass',
      frequency: { value: 2_400 },
      Q: { value: 0.55 },
    });
    expect(context.source.stop).toHaveBeenCalledOnce();
    expect(context.oscillator.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('pauses the Piper stimulus and closes the active noise graph on abort', async () => {
    installReplayEnvironment(false);
    const controller = new AbortController();
    const playback = playAcousticPrompt({
      utteranceId: 'finding-suppuration-u01',
      prompt: 'suppuration',
      noisy: true,
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 8 && MockAudio.instances[0].play.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    controller.abort();

    await expect(playback).rejects.toMatchObject({ name: 'AbortError' });
    expect(MockAudio.instances[0].pause).toHaveBeenCalledOnce();
    expect(MockAudio.instances[0].currentTime).toBe(0);
    expect(MockReplayAudioContext.instances[0].close).toHaveBeenCalledOnce();
  });

  it('measures little-endian PCM16 and treats malformed or silent clips as inaudible', async () => {
    const signal = new Int16Array([3_276, -3_276, 3_276, -3_276]);
    const measured = await measurePcm16(new Blob([signal.buffer]));
    expect(measured.rms).toBeCloseTo(0.1, 3);
    expect(measured.peak).toBeCloseTo(0.1, 3);
    await expect(measurePcm16(new Blob([new Uint8Array([1])]))).resolves.toEqual({
      rms: 0,
      peak: 0,
    });
  });
});
