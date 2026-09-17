import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asrWebSocketUrl, parseServerMessage } from '../src/speech/protocol';
import { useLocalAsr } from '../src/speech/useLocalAsr';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  binaryType = '';
  sent: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(value: string | ArrayBuffer) {
    this.sent.push(value);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(value: object) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

const stopTrack = vi.fn();
const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
const addModule = vi.fn().mockResolvedValue(undefined);
const sourceNode = { connect: vi.fn(), disconnect: vi.fn() };
const muteNode = {
  gain: { value: 1 },
  connect: vi.fn(),
  disconnect: vi.fn(),
};

class MockAudioContext {
  static instance: MockAudioContext | null = null;
  audioWorklet = { addModule };
  destination = {} as AudioDestinationNode;
  createMediaStreamSource = vi.fn(() => sourceNode as unknown as MediaStreamAudioSourceNode);
  createGain = vi.fn(() => muteNode as unknown as GainNode);
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);

  constructor() {
    MockAudioContext.instance = this;
  }
}

class MockAudioWorkletNode {
  static instance: MockAudioWorkletNode | null = null;
  port = { onmessage: null as ((event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => void) | null };
  connect = vi.fn();
  disconnect = vi.fn();

  constructor() {
    MockAudioWorkletNode.instance = this;
  }
}

function installAudioEnvironment() {
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('AudioContext', MockAudioContext);
  vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
}

function ready(socket: MockWebSocket) {
  act(() => {
    socket.open();
    socket.message({ type: 'hello', protocol: 1 });
    socket.message({
      type: 'model_ready',
      status: 'ready',
      model: 'tiny.en',
      device: 'cpu',
      computeType: 'int8',
    });
  });
}

beforeEach(() => {
  MockWebSocket.instances = [];
  MockAudioWorkletNode.instance = null;
  MockAudioContext.instance = null;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
});

describe('local ASR browser adapter', () => {
  it('captures PCM, exposes partials, commits finals, and releases every resource', async () => {
    installAudioEnvironment();
    const onFinal = vi.fn();
    const { result, unmount } = renderHook(() =>
      useLocalAsr({ onFinal, contextVersion: () => 7 }));
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toBe('ws://localhost:3000/ws/asr');
    ready(socket);
    expect(result.current.status).toBe('ready');
    expect(result.current.model).toEqual({ name: 'tiny.en', device: 'cpu', computeType: 'int8' });

    await act(async () => result.current.start());
    expect(addModule).toHaveBeenCalledWith('/audio/pcm-capture-worklet.js');
    expect(socket.sent).toContain(JSON.stringify({ type: 'start' }));
    act(() => socket.message({ type: 'listening' }));
    expect(result.current.listening).toBe(true);

    const pcm = new ArrayBuffer(3_200);
    act(() => MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm, level: 0.1 },
    } as MessageEvent<{ pcm: ArrayBuffer; level: number }>));
    expect(socket.sent).toContain(pcm);
    expect(result.current.audioLevel).toBeCloseTo(0.4);

    act(() => {
      // The context version is captured here, not at commit, so a final that a
      // later jump overtook can still be recognized as stale.
      socket.message({ type: 'speech_start', utteranceId: 1 });
      socket.message({ type: 'partial', text: 'three four', decodeMs: 12 });
    });
    expect(result.current.status).toBe('processing');
    expect(result.current.interimTranscript).toBe('three four');
    expect(onFinal).not.toHaveBeenCalled();

    act(() => socket.message({
      type: 'final',
      text: 'three four five',
      decodeMs: 18,
      audioMs: 720,
      utteranceId: 1,
      words: [{ word: 'three', startMs: 0, endMs: 240, probability: 0.97 }],
      speaker: { decision: 'clinician', similarity: 0.98, enrolled: true, voicedMs: 700 },
      cadence: { endSilenceMs: 430, wordsPerSecond: 3.2, pauseP90Ms: 90, samples: 1, adaptive: true },
    }));
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({
      transcript: 'three four five',
      timing: expect.objectContaining({
        startedAt: expect.any(Number),
        observedAt: expect.any(Number),
      }),
      words: [{ word: 'three', startMs: 0, endMs: 240, probability: 0.97 }],
      utteranceId: 1,
      audioMs: 720,
      decodeMs: 18,
      speaker: { decision: 'clinician', similarity: 0.98, overridden: false },
      observedVersion: 7,
    }));
    expect(result.current.speaker?.decision).toBe('clinician');
    expect(result.current.cadence).toMatchObject({ endSilenceMs: 430, adaptive: true });
    expect(result.current.interimTranscript).toBe('');
    expect(result.current.latestDecodeMs).toBe(18);

    act(() => result.current.stop());
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(sourceNode.disconnect).toHaveBeenCalledOnce();
    expect(MockAudioWorkletNode.instance?.disconnect).toHaveBeenCalledOnce();
    expect(socket.sent).toContain(JSON.stringify({ type: 'stop' }));
    unmount();
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('reconnects after a dropped service connection', async () => {
    vi.useFakeTimers();
    installAudioEnvironment();
    const { result } = renderHook(() => useLocalAsr({ onFinal: vi.fn() }));
    const first = MockWebSocket.instances[0];
    ready(first);
    act(() => first.close());
    expect(result.current.status).toBe('offline');
    act(() => vi.advanceTimersByTime(500));
    expect(MockWebSocket.instances).toHaveLength(2);
    ready(MockWebSocket.instances[1]);
    expect(result.current.status).toBe('ready');
  });

  it('requests a model reload without dropping a healthy socket', () => {
    installAudioEnvironment();
    const { result } = renderHook(() => useLocalAsr({ onFinal: vi.fn() }));
    const socket = MockWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.message({
        type: 'model_status',
        status: 'error',
        model: 'tiny.en',
        device: 'cpu',
        computeType: 'int8',
        error: 'download interrupted',
      });
    });
    expect(result.current.status).toBe('error');
    act(() => result.current.retry());
    expect(socket.sent).toContain(JSON.stringify({ type: 'retry_model' }));
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    expect(result.current.status).toBe('loading-model');
  });

  it('releases the stream and audio context when worklet setup fails', async () => {
    installAudioEnvironment();
    addModule.mockRejectedValueOnce(new Error('worklet could not load'));
    const { result } = renderHook(() => useLocalAsr({ onFinal: vi.fn() }));
    ready(MockWebSocket.instances[0]);

    await act(async () => result.current.start());
    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/worklet could not load/i);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(MockAudioContext.instance?.close).toHaveBeenCalledOnce();
  });

  it('keeps the deterministic simulator available when capture APIs are unsupported', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('AudioWorkletNode', undefined);
    const { result } = renderHook(() => useLocalAsr({ onFinal: vi.fn() }));
    expect(result.current.supported).toBe(false);
    expect(result.current.status).toBe('unsupported');
    expect(result.current.error).toBeNull();
    act(() => void result.current.start());
    expect(result.current.error).toMatch(/transcript simulator/i);
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe('ASR protocol helpers', () => {
  it('selects secure websocket URLs and rejects malformed messages', () => {
    expect(asrWebSocketUrl({ protocol: 'https:', host: 'clinic.test' } as Location))
      .toBe('wss://clinic.test/ws/asr');
    expect(parseServerMessage('{"type":"partial","text":"three"}')?.text).toBe('three');
    expect(parseServerMessage('{bad')).toBeNull();
    expect(parseServerMessage('[]')).toBeNull();
  });
});
