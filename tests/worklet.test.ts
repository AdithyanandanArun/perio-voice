import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

interface WorkletOptions {
  processorOptions?: { targetSampleRate?: number; batchMs?: number };
}

interface CapturedWorklet {
  port: {
    postMessage: (value: { pcm: ArrayBuffer; level: number }, transfer: ArrayBuffer[]) => void;
  };
  process: (inputs: Float32Array[][]) => boolean;
}

type WorkletConstructor = new (options: WorkletOptions) => CapturedWorklet;

describe('PCM capture worklet', () => {
  it('downsamples 48 kHz audio to one 100 ms PCM16 batch and transfers ownership', () => {
    const source = readFileSync('public/audio/pcm-capture-worklet.js', 'utf8');
    const messages: { value: { pcm: ArrayBuffer; level: number }; transfer: ArrayBuffer[] }[] = [];
    let Processor: WorkletConstructor | undefined;

    class AudioWorkletProcessorStub {
      port = {
        postMessage: (value: { pcm: ArrayBuffer; level: number }, transfer: ArrayBuffer[]) => {
          messages.push({ value, transfer });
        },
      };
    }

    vm.runInNewContext(source, {
      AudioWorkletProcessor: AudioWorkletProcessorStub,
      Float32Array,
      Int16Array,
      Math,
      sampleRate: 48_000,
      registerProcessor: (name: string, constructor: WorkletConstructor) => {
        expect(name).toBe('pcm-capture-processor');
        Processor = constructor;
      },
    });

    expect(Processor).toBeDefined();
    const worklet = new (Processor as WorkletConstructor)({
      processorOptions: { targetSampleRate: 16_000, batchMs: 100 },
    });
    const input = new Float32Array(4_801).fill(0.5);
    expect(worklet.process([[input]])).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].value.pcm.byteLength).toBe(3_200);
    expect(messages[0].value.level).toBeCloseTo(0.5, 4);
    expect(messages[0].transfer).toEqual([messages[0].value.pcm]);
    expect(new Int16Array(messages[0].value.pcm)[0]).toBeCloseTo(16_384, -1);
  });
});
