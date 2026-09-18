import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

interface WorkletOptions {
  processorOptions?: { targetSampleRate?: number; batchMs?: number };
}

interface WorkletMessage {
  pcm: ArrayBuffer;
  level: number;
  sampleRate?: number;
  startSample?: number;
  endSample?: number;
}

interface CapturedWorklet {
  port: {
    postMessage: (value: WorkletMessage, transfer: ArrayBuffer[]) => void;
  };
  process: (inputs: Float32Array[][]) => boolean;
}

type WorkletConstructor = new (options: WorkletOptions) => CapturedWorklet;

interface TypedArrayAllocations {
  float32: number;
  float64: number;
  int16: number;
}

type CountedTypedArrayConstructor =
  | typeof Float32Array
  | typeof Float64Array
  | typeof Int16Array;

const SOURCE_SAMPLE_RATE = 48_000;
const TARGET_SAMPLE_RATE = 16_000;
const RENDER_QUANTUM = 128;

function countingConstructor<T extends CountedTypedArrayConstructor>(
  constructor: T,
  allocations: TypedArrayAllocations,
  key: keyof TypedArrayAllocations,
): T {
  return new Proxy(constructor, {
    construct(target, argumentsList) {
      allocations[key] += 1;
      return Reflect.construct(target, argumentsList, target);
    },
  });
}

function createWorklet(batchMs = 40) {
  const source = readFileSync('public/audio/pcm-capture-worklet.js', 'utf8');
  const messages: { value: WorkletMessage; transfer: ArrayBuffer[] }[] = [];
  const allocations: TypedArrayAllocations = { float32: 0, float64: 0, int16: 0 };
  let Processor: WorkletConstructor | undefined;

  class AudioWorkletProcessorStub {
    port = {
      postMessage: (value: WorkletMessage, transfer: ArrayBuffer[]) => {
        messages.push({ value, transfer });
      },
    };
  }

  vm.runInNewContext(source, {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    Float32Array: countingConstructor(Float32Array, allocations, 'float32'),
    Float64Array: countingConstructor(Float64Array, allocations, 'float64'),
    Int16Array: countingConstructor(Int16Array, allocations, 'int16'),
    Math,
    sampleRate: SOURCE_SAMPLE_RATE,
    registerProcessor: (name: string, constructor: WorkletConstructor) => {
      expect(name).toBe('pcm-capture-processor');
      Processor = constructor;
    },
  });

  expect(Processor).toBeDefined();
  const worklet = new (Processor as WorkletConstructor)({
    processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, batchMs },
  });

  return { allocations, messages, worklet };
}

function pcmRms(pcm: Int16Array): number {
  let squareSum = 0;
  for (const sample of pcm) {
    const normalized = sample / 32_768;
    squareSum += normalized * normalized;
  }
  return Math.sqrt(squareSum / pcm.length);
}

function toneAmplitude(pcm: Int16Array, frequency: number): number {
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = pcm[index] / 32_768;
    const phase = 2 * Math.PI * frequency * index / TARGET_SAMPLE_RATE;
    real += sample * Math.cos(phase);
    imaginary -= sample * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / pcm.length;
}

function captureTone(frequency: number) {
  const { messages, worklet } = createWorklet();
  let sourceIndex = 0;

  for (let quantum = 0; quantum < 120 && messages.length < 3; quantum += 1) {
    const input = new Float32Array(RENDER_QUANTUM);
    for (let index = 0; index < input.length; index += 1) {
      input[index] = 0.75 * Math.sin(
        2 * Math.PI * frequency * (sourceIndex + index) / SOURCE_SAMPLE_RATE,
      );
    }
    expect(worklet.process([[input]])).toBe(true);
    sourceIndex += input.length;
  }

  expect(messages).toHaveLength(3);
  return messages[2];
}

describe('PCM capture worklet', () => {
  it('downsamples 48 kHz audio to one 40 ms PCM16 batch and transfers ownership', () => {
    const { messages, worklet } = createWorklet();
    const input = new Float32Array(1_921).fill(0.5);

    expect(worklet.process([[input]])).toBe(true);

    expect(messages).toHaveLength(1);
    expect(messages[0].value.pcm.byteLength).toBe(1_280);
    const pcm = new Int16Array(messages[0].value.pcm);
    expect(pcm).toHaveLength(640);
    expect(messages[0].value.level).toBeCloseTo(pcmRms(pcm), 4);
    expect(messages[0].value.level).toBeGreaterThan(0.49);
    expect(messages[0].transfer).toEqual([messages[0].value.pcm]);
    expect(messages[0].value.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(messages[0].value.startSample).toBe(0);
    expect(messages[0].value.endSample).toBe(640);
    expect(pcm.at(-1)).toBeCloseTo(16_384, -1);
  });

  it('retains an explicit legacy batch size for non-live callers', () => {
    const { messages, worklet } = createWorklet(100);
    expect(worklet.process([[new Float32Array(4_801).fill(0.5)]])).toBe(true);
    expect(messages).toHaveLength(1);
    expect(new Int16Array(messages[0].value.pcm)).toHaveLength(1_600);
    expect(messages[0].value.endSample).toBe(1_600);
  });

  it('keeps render-quantum filter storage allocation-stable', () => {
    const { allocations, messages, worklet } = createWorklet(100);
    const constructorAllocations = { ...allocations };
    const silence = new Float32Array(RENDER_QUANTUM);

    for (let quantum = 0; quantum < 37; quantum += 1) {
      expect(worklet.process([[silence]])).toBe(true);
    }

    expect(messages).toHaveLength(0);
    expect(allocations).toEqual(constructorAllocations);

    expect(worklet.process([[silence]])).toBe(true);
    expect(messages).toHaveLength(1);
    expect(allocations).toEqual({
      ...constructorAllocations,
      int16: constructorAllocations.int16 + 1,
    });
  });

  it('preserves an in-band tone while rejecting its above-Nyquist alias', () => {
    const passbandMessage = captureTone(4_000);
    const stopbandMessage = captureTone(12_000);
    const passband = new Int16Array(passbandMessage.value.pcm);
    const stopband = new Int16Array(stopbandMessage.value.pcm);
    const passbandAmplitude = toneAmplitude(passband, 4_000);
    const aliasedAmplitude = toneAmplitude(stopband, 4_000);

    expect(passbandAmplitude).toBeGreaterThan(0.7);
    expect(aliasedAmplitude).toBeLessThan(0.02);
    expect(aliasedAmplitude).toBeLessThan(passbandAmplitude * 0.03);
    expect(passbandMessage.value.level).toBeCloseTo(pcmRms(passband), 4);
    expect(stopbandMessage.value.level).toBeCloseTo(pcmRms(stopband), 4);
    expect(stopbandMessage.value.level).toBeLessThan(passbandMessage.value.level * 0.03);
  });
});
