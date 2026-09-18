import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureSeconds } from '../src/speech/capture';
import {
  asrWebSocketUrl,
  MAX_BUFFERED_AUDIO_BYTES,
  parseServerMessage,
  type AsrEndpoint,
  type AsrPartial,
} from '../src/speech/protocol';
import { useLocalAsr } from '../src/speech/useLocalAsr';

interface MockWorkletAudio {
  pcm: ArrayBuffer;
  level: number;
  startSample?: number;
  endSample?: number;
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  binaryType = '';
  bufferedAmount = 0;
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
  port = { onmessage: null as ((event: MessageEvent<MockWorkletAudio>) => void) | null };
  readonly processorOptions: unknown;
  connect = vi.fn();
  disconnect = vi.fn();

  constructor(
    _context?: unknown,
    _name?: string,
    options?: { processorOptions?: unknown },
  ) {
    this.processorOptions = options?.processorOptions;
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

async function waitForCaptureGraph() {
  for (let attempt = 0; attempt < 12 && !MockAudioWorkletNode.instance; attempt += 1) {
    await Promise.resolve();
  }
  expect(MockAudioWorkletNode.instance).not.toBeNull();
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
    const onPartial = vi.fn<(partial: AsrPartial) => void>();
    const onEndpoint = vi.fn<(endpoint: AsrEndpoint) => void>();
    const { result, unmount } = renderHook(() =>
      useLocalAsr({ onFinal, onPartial, onEndpoint, contextVersion: () => 7 }));
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toBe('ws://localhost:3000/ws/asr');
    ready(socket);
    expect(result.current.status).toBe('ready');
    expect(result.current.model).toEqual({ name: 'tiny.en', device: 'cpu', computeType: 'int8' });

    await act(async () => result.current.start());
    expect(addModule).toHaveBeenCalledWith('/audio/pcm-capture-worklet.js');
    expect(MockAudioWorkletNode.instance?.processorOptions).toEqual({
      targetSampleRate: 16_000,
      batchMs: 20,
    });
    const startControl = socket.sent.find((value): value is string =>
      typeof value === 'string' && JSON.parse(value).type === 'start');
    expect(startControl).toBeDefined();
    expect(JSON.parse(startControl as string)).toEqual({
      type: 'start',
      streamId: expect.any(String),
    });
    act(() => socket.message({ type: 'listening' }));
    expect(result.current.listening).toBe(true);

    const pcm = new ArrayBuffer(640);
    act(() => MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm, level: 0.1, startSample: 0, endSample: 320 },
    } as MessageEvent<MockWorkletAudio>));
    expect(socket.sent).toContain(pcm);
    expect(result.current.audioLevel).toBeCloseTo(0.4);

    socket.bufferedAmount = 10_000;
    const blockedPcm = new ArrayBuffer(640);
    act(() => MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm: blockedPcm, level: 0.2, startSample: 320, endSample: 640 },
    } as MessageEvent<MockWorkletAudio>));
    expect(socket.sent).not.toContain(blockedPcm);
    const blockedPcm2 = new ArrayBuffer(640);
    act(() => MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm: blockedPcm2, level: 0.2, startSample: 640, endSample: 960 },
    } as MessageEvent<MockWorkletAudio>));
    expect(socket.sent).not.toContain(blockedPcm2);
    expect(socket.sent.filter((value) =>
      typeof value === 'string' && JSON.parse(value).type === 'audio_gap')).toHaveLength(0);

    socket.bufferedAmount = 0;
    const resumedPcm = new ArrayBuffer(640);
    act(() => MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm: resumedPcm, level: 0.2, startSample: 960, endSample: 1_280 },
    } as MessageEvent<MockWorkletAudio>));
    const gapIndex = socket.sent.findIndex((value) =>
      typeof value === 'string' && JSON.parse(value).type === 'audio_gap');
    const resumedIndex = socket.sent.indexOf(resumedPcm);
    expect(gapIndex).toBeGreaterThan(-1);
    expect(gapIndex).toBeLessThan(resumedIndex);
    expect(JSON.parse(socket.sent[gapIndex] as string)).toEqual({
      type: 'audio_gap',
      streamId: expect.any(String),
      sampleRate: 16_000,
      startSample: 320,
      endSample: 960,
    });

    act(() => {
      // The context version is captured here, not at commit, so a final that a
      // later jump overtook can still be recognized as stale.
      socket.message({
        type: 'speech_start',
        streamId: 'stream-1',
        utteranceId: 1,
        originalContextVersion: 7,
        startSample: 32_000,
      });
      socket.message({
        type: 'partial',
        streamId: 'stream-1',
        transactionId: 'tx-1',
        revision: 2,
        text: 'three four',
        decodeMs: 12,
        startSample: 32_000,
        endSample: 35_200,
        recognitionPath: 'fast',
      });
    });
    expect(result.current.status).toBe('processing');
    expect(result.current.interimTranscript).toBe('three four');
    expect(onFinal).not.toHaveBeenCalled();
    expect(onPartial).toHaveBeenCalledWith(expect.objectContaining({
      streamId: 'stream-1',
      transactionId: 'tx-1',
      revision: 2,
      lifecycle: 'provisional',
      recognitionPath: 'fast',
      timing: expect.objectContaining({
        startSample: 32_000,
        endSample: 35_200,
        durationSamples: 3_200,
        sampleRate: 16_000,
      }),
    }));

    act(() => socket.message({
      type: 'endpoint',
      streamId: 'stream-1',
      transactionId: 'tx-1',
      revision: 3,
      endSample: 36_800,
      audioMs: 300,
    }));
    expect(onEndpoint).toHaveBeenCalledWith(expect.objectContaining({
      streamId: 'stream-1',
      transactionId: 'tx-1',
      revision: 3,
      timing: expect.objectContaining({ endSample: 36_800, sampleRate: 16_000 }),
    }));

    act(() => socket.message({
      type: 'final',
      streamId: 'stream-1',
      transactionId: 'tx-1',
      revision: 4,
      originalContextVersion: 7,
      text: 'three four five',
      decodeMs: 18,
      audioMs: 720,
      utteranceId: 1,
      startSample: 32_000,
      endSample: 43_520,
      recognitionPath: 'terminal',
      startedAtMs: 9_000_000,
      endedAtMs: 9_000_720,
      words: [{ word: 'three', startMs: 0, endMs: 240, probability: 0.97 }],
      speaker: { decision: 'clinician', similarity: 0.98, enrolled: true, voicedMs: 700 },
      cadence: { endSilenceMs: 430, wordsPerSecond: 3.2, pauseP90Ms: 90, samples: 1, adaptive: true },
    }));
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({
      transcript: 'three four five',
      timing: expect.objectContaining({
        startedAt: expect.any(Number),
        observedAt: expect.any(Number),
        startSample: 32_000,
        endSample: 43_520,
        durationSamples: 11_520,
        sampleRate: 16_000,
      }),
      words: [{ word: 'three', startMs: 0, endMs: 240, probability: 0.97 }],
      utteranceId: 1,
      streamId: 'stream-1',
      transactionId: 'tx-1',
      revision: 4,
      originalContextVersion: 7,
      lifecycle: 'confirmed',
      recognitionPath: 'terminal',
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

  it('flushes an unrecovered audio gap before sending stop', async () => {
    installAudioEnvironment();
    const { result, unmount } = renderHook(() => useLocalAsr({ onFinal: vi.fn() }));
    const socket = MockWebSocket.instances[0];
    ready(socket);

    await act(async () => result.current.start());
    socket.bufferedAmount = MAX_BUFFERED_AUDIO_BYTES;
    const droppedPcm = new ArrayBuffer(1_280);
    act(() => MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm: droppedPcm, level: 0.2, startSample: 0, endSample: 640 },
    } as MessageEvent<MockWorkletAudio>));
    expect(socket.sent).not.toContain(droppedPcm);

    act(() => result.current.stop());
    const gapIndex = socket.sent.findIndex((value) =>
      typeof value === 'string' && JSON.parse(value).type === 'audio_gap');
    const stopIndex = socket.sent.findIndex((value) =>
      value === JSON.stringify({ type: 'stop' }));
    expect(gapIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBe(gapIndex + 1);
    expect(JSON.parse(socket.sent[gapIndex] as string)).toEqual({
      type: 'audio_gap',
      streamId: expect.any(String),
      sampleRate: 16_000,
      startSample: 0,
      endSample: 640,
    });
    unmount();
  });

  it('declares the clinical expectation so the service can narrow its grammar', async () => {
    installAudioEnvironment();
    const { result } = renderHook(() => useLocalAsr({ onFinal: vi.fn() }));
    const socket = MockWebSocket.instances[0];
    ready(socket);

    act(() => result.current.declareExpectation('depths'));
    expect(socket.sent).toContain(JSON.stringify({ type: 'context', expect: 'depths' }));

    // Repeating the same expectation must not re-send; it changes nothing.
    const sentCount = socket.sent.length;
    act(() => result.current.declareExpectation('depths'));
    expect(socket.sent).toHaveLength(sentCount);

    act(() => result.current.declareExpectation('clinical'));
    expect(socket.sent).toContain(JSON.stringify({ type: 'context', expect: 'clinical' }));
  });

  it('keeps a disconnected expectation and gates PCM behind the start/context handshake', async () => {
    installAudioEnvironment();
    let version = 11;
    const { result } = renderHook(() => useLocalAsr({
      onFinal: vi.fn(),
      contextVersion: () => version,
    }));
    const socket = MockWebSocket.instances[0];

    // This declaration happens while the socket is still CONNECTING.
    act(() => result.current.declareExpectation('depths'));
    ready(socket);
    expect(socket.sent).toContain(JSON.stringify({
      type: 'context',
      expect: 'depths',
      contextVersion: 11,
    }));

    await act(async () => result.current.start());
    const start = socket.sent.find((value): value is string =>
      typeof value === 'string' && JSON.parse(value).type === 'start');
    expect(JSON.parse(start as string)).toEqual({
      type: 'start',
      streamId: expect.any(String),
      expect: 'depths',
      contextVersion: 11,
    });

    const earlyPcm = new ArrayBuffer(640);
    act(() => MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm: earlyPcm, level: 0.2, startSample: 0, endSample: 320 },
    } as MessageEvent<MockWorkletAudio>));
    expect(socket.sent).not.toContain(earlyPcm);

    // No audio can pass until the service confirms both start and context.
    act(() => socket.message({ type: 'listening' }));
    const resumedPcm = new ArrayBuffer(640);
    act(() => MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm: resumedPcm, level: 0.2, startSample: 320, endSample: 640 },
    } as MessageEvent<MockWorkletAudio>));
    const gapIndex = socket.sent.findIndex((value) =>
      typeof value === 'string' && JSON.parse(value).type === 'audio_gap');
    expect(gapIndex).toBeGreaterThan(-1);
    expect(gapIndex).toBeLessThan(socket.sent.indexOf(resumedPcm));
    expect(JSON.parse(socket.sent[gapIndex] as string)).toMatchObject({
      startSample: 0,
      endSample: 320,
    });

    version = 12;
    act(() => result.current.declareExpectation('clinical'));
    expect(socket.sent).toContain(JSON.stringify({
      type: 'context',
      expect: 'clinical',
      contextVersion: 12,
    }));
  });

  it('preserves a gap across reconnect and re-declares the latest expectation', async () => {
    vi.useFakeTimers();
    installAudioEnvironment();
    let version = 3;
    const { result, unmount } = renderHook(() => useLocalAsr({
      onFinal: vi.fn(),
      contextVersion: () => version,
    }));
    const first = MockWebSocket.instances[0];
    act(() => result.current.declareExpectation('depths'));
    ready(first);
    await act(async () => result.current.start());
    act(() => first.message({ type: 'listening' }));

    const firstPcm = new ArrayBuffer(640);
    act(() => MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm: firstPcm, level: 0.2, startSample: 0, endSample: 320 },
    } as MessageEvent<MockWorkletAudio>));

    act(() => first.close());
    version = 4;
    act(() => result.current.declareExpectation('clinical'));
    const disconnectedPcm = new ArrayBuffer(640);
    act(() => MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm: disconnectedPcm, level: 0.2, startSample: 320, endSample: 640 },
    } as MessageEvent<MockWorkletAudio>));
    expect(first.sent).not.toContain(disconnectedPcm);

    act(() => vi.advanceTimersByTime(500));
    const second = MockWebSocket.instances[1];
    ready(second);
    const reconnectStart = second.sent.find((value): value is string =>
      typeof value === 'string' && JSON.parse(value).type === 'start');
    expect(JSON.parse(reconnectStart as string)).toMatchObject({
      type: 'start',
      expect: 'clinical',
      contextVersion: 4,
    });
    act(() => second.message({ type: 'listening' }));

    const recoveredPcm = new ArrayBuffer(640);
    act(() => MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm: recoveredPcm, level: 0.2, startSample: 640, endSample: 960 },
    } as MessageEvent<MockWorkletAudio>));
    const gapIndex = second.sent.findIndex((value) =>
      typeof value === 'string' && JSON.parse(value).type === 'audio_gap');
    const pcmIndex = second.sent.indexOf(recoveredPcm);
    expect(gapIndex).toBeGreaterThan(-1);
    expect(gapIndex).toBeLessThan(pcmIndex);
    expect(JSON.parse(second.sent[gapIndex] as string)).toMatchObject({
      startSample: 0,
      endSample: 640,
    });
    unmount();
  });

  it('keeps listening through gap acknowledgements and recoverable gap errors', async () => {
    installAudioEnvironment();
    const { result } = renderHook(() => useLocalAsr({ onFinal: vi.fn() }));
    const socket = MockWebSocket.instances[0];
    ready(socket);
    await act(async () => result.current.start());
    act(() => socket.message({ type: 'listening' }));

    act(() => socket.message({ type: 'audio_gap_ack', startSample: 0, endSample: 320 }));
    expect(result.current.status).toBe('listening');
    act(() => socket.message({
      type: 'error',
      code: 'audio_gap',
      recoverable: false,
      message: 'gap accepted but could not be replayed',
    }));
    expect(result.current.status).toBe('listening');
    expect(result.current.error).toMatch(/gap accepted/i);
  });

  it('re-declares the expectation after a reconnect, since the service forgets it', () => {
    vi.useFakeTimers();
    installAudioEnvironment();
    const { result } = renderHook(() => useLocalAsr({ onFinal: vi.fn() }));
    ready(MockWebSocket.instances[0]);
    act(() => result.current.declareExpectation('depths'));

    act(() => MockWebSocket.instances[0].close());
    act(() => vi.advanceTimersByTime(500));
    const reconnected = MockWebSocket.instances[1];
    ready(reconnected);

    act(() => result.current.declareExpectation('depths'));
    expect(reconnected.sent).toContain(JSON.stringify({ type: 'context', expect: 'depths' }));
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

describe('shared worklet capture', () => {
  it('returns worklet PCM and releases the full audio graph after the requested duration', async () => {
    vi.useFakeTimers();
    installAudioEnvironment();
    const onLevel = vi.fn();
    const recording = captureSeconds(1, { onLevel });
    await waitForCaptureGraph();

    const pcm = new Uint8Array([1, 0, 2, 0]).buffer;
    MockAudioWorkletNode.instance?.port.onmessage?.({
      data: { pcm, level: 0.2 },
    } as MessageEvent<MockWorkletAudio>);
    await vi.advanceTimersByTimeAsync(1_000);

    const blob = await recording;
    expect(MockAudioWorkletNode.instance?.processorOptions).toEqual({
      targetSampleRate: 16_000,
      batchMs: 100,
    });
    expect(blob.size).toBe(pcm.byteLength);
    expect(blob.type).toBe('application/octet-stream');
    expect(onLevel).toHaveBeenNthCalledWith(1, 0.2);
    expect(onLevel).toHaveBeenLastCalledWith(0);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(sourceNode.disconnect).toHaveBeenCalledOnce();
    expect(MockAudioWorkletNode.instance?.disconnect).toHaveBeenCalledOnce();
    expect(muteNode.disconnect).toHaveBeenCalledOnce();
    expect(MockAudioContext.instance?.close).toHaveBeenCalledOnce();
  });

  it('aborts worklet capture and still releases every acquired resource', async () => {
    installAudioEnvironment();
    const controller = new AbortController();
    const recording = captureSeconds(10, { signal: controller.signal });
    await waitForCaptureGraph();

    controller.abort();
    await expect(recording).rejects.toMatchObject({ name: 'AbortError' });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(sourceNode.disconnect).toHaveBeenCalledOnce();
    expect(MockAudioWorkletNode.instance?.disconnect).toHaveBeenCalledOnce();
    expect(muteNode.disconnect).toHaveBeenCalledOnce();
    expect(MockAudioContext.instance?.close).toHaveBeenCalledOnce();
  });

  it('starts synchronized loudspeaker playback only after capture is live and disables echo cancellation', async () => {
    vi.useFakeTimers();
    installAudioEnvironment();
    const onReady = vi.fn();
    const recording = captureSeconds(1, {
      profile: 'loudspeaker-replay',
      onReady,
    });
    await waitForCaptureGraph();

    expect(MockAudioContext.instance?.resume).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(recording).resolves.toBeInstanceOf(Blob);
  });

  it('rejects unsafe durations before asking for microphone access', async () => {
    installAudioEnvironment();
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    await expect(captureSeconds(0)).rejects.toThrow(/duration/i);
    await expect(captureSeconds(31)).rejects.toThrow(/duration/i);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
