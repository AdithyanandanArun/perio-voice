import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const protocol = readFileSync(resolve(root, 'src/speech/protocol.ts'), 'utf8');
const adapter = readFileSync(resolve(root, 'src/speech/useLocalAsr.ts'), 'utf8');
const capture = readFileSync(resolve(root, 'src/speech/capture.ts'), 'utf8');
const workletSource = readFileSync(
  resolve(root, 'public/audio/pcm-capture-worklet.js'),
  'utf8',
);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertMatch(source, expression, message) {
  assert(expression.test(source), message);
}

function numericConstant(source, name) {
  const match = source.match(new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*([0-9][0-9_]*(?:\\.[0-9_]+)?)`));
  assert(match, `missing numeric constant ${name}`);
  return Number(match[1].replaceAll('_', ''));
}

function validateStructure({ protocolSource = protocol, adapterSource = adapter, worklet = workletSource } = {}) {
  const liveBatchMs = numericConstant(protocolSource, 'LIVE_BATCH_MS');
  const captureBatchMs = numericConstant(protocolSource, 'CAPTURE_BATCH_MS');
  assert(liveBatchMs === 20, `live capture batch must be exactly 20 ms (got ${liveBatchMs})`);
  assert(captureBatchMs > liveBatchMs, 'fixture/enrollment cadence must remain larger than live cadence');
  assert(numericConstant(protocolSource, 'TARGET_SAMPLE_RATE') === 16_000, 'target sample rate changed');
  assertMatch(protocolSource, /LIVE_BATCH_SAMPLES\s*=\s*TARGET_SAMPLE_RATE\s*\*\s*LIVE_BATCH_MS/, 'live sample floor is not derived from the live cadence');
  assertMatch(protocolSource, /MAX_BUFFERED_AUDIO_BYTES\s*=\s*LIVE_BATCH_SAMPLES[\s\S]*\*\s*3/, 'native WebSocket backlog is not bounded from live frames');
  assertMatch(protocolSource, /type:\s*'audio_gap'/, 'audio_gap control type is missing');
  assertMatch(protocolSource, /startSample:\s*number[\s\S]*endSample:\s*number/, 'audio_gap sample range is missing');

  assertMatch(adapterSource, /bufferedAmount/, 'adapter does not inspect native WebSocket backlog');
  assertMatch(adapterSource, /MAX_BUFFERED_AUDIO_BYTES/, 'adapter does not enforce the backlog bound');
  assertMatch(adapterSource, /audioGapsRef/, 'adapter has no pending gap ledger');
  assertMatch(adapterSource, /recordAudioGap/, 'adapter does not preserve dropped ranges');
  assertMatch(adapterSource, /sendContextControl/, 'adapter has no context handshake');
  assertMatch(adapterSource, /desiredExpectationRef/, 'desired expectation is not retained while disconnected');
  assertMatch(adapterSource, /transportReadyRef/, 'adapter has no start/context audio barrier');
  assertMatch(adapterSource, /type:\s*'start'/, 'start control is missing');
  assertMatch(adapterSource, /contextVersion/, 'context version is not transported');
  assertMatch(adapterSource, /case 'audio_gap_ack'/, 'audio gap acknowledgement is not handled');
  assertMatch(adapterSource, /case 'audio_gap_error'/, 'audio gap error is not handled');
  assertMatch(adapterSource, /case 'partial'/, 'partial message path is missing');
  assertMatch(adapterSource, /onFinalRef\.current/, 'final callback path is missing');
  assertMatch(adapterSource, /case 'final'/, 'terminal final path is missing');

  assertMatch(capture, /CAPTURE_BATCH_MS/, 'fixture capture no longer has its explicit cadence');
  assertMatch(adapterSource, /batchMs:\s*LIVE_BATCH_MS/, 'live adapter does not pass the live cadence');

  assertMatch(worklet, /lowpassSections\s*=\s*4/, 'anti-alias low-pass sections were removed');
  assertMatch(worklet, /lowpassCoefficients/, 'anti-alias coefficients are missing');
  assertMatch(worklet, /lowpassState/, 'anti-alias filter state is missing');
  assertMatch(worklet, /copyWithin/, 'worklet no longer reuses its input storage');
  assertMatch(worklet, /postMessage\([\s\S]*pcm\.buffer[\s\S]*\[pcm\.buffer\]/, 'PCM ownership is not transferred');
  assertMatch(worklet, /: 20;/, 'worklet default cadence is not 20 ms');
}

function loadWorklet(batchMs = 20) {
  const messages = [];
  let Processor;
  class AudioWorkletProcessorStub {
    constructor() {
      this.port = {
        postMessage: (value, transfer) => messages.push({ value, transfer }),
      };
    }
  }
  vm.runInNewContext(workletSource, {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    Float32Array,
    Float64Array,
    Int16Array,
    Math,
    sampleRate: 48_000,
    registerProcessor: (name, constructor) => {
      assert(name === 'pcm-capture-processor', `unexpected worklet name ${name}`);
      Processor = constructor;
    },
  });
  assert(Processor, 'worklet did not register a processor');
  const worklet = new Processor({
    processorOptions: { targetSampleRate: 16_000, batchMs },
  });
  return { messages, worklet };
}

function measureCaptureFloor() {
  const { messages, worklet } = loadWorklet();
  const quantum = 128;
  let sourceQuanta = 0;
  while (messages.length === 0 && sourceQuanta < 20) {
    worklet.process([[new Float32Array(quantum).fill(0.25)]]);
    sourceQuanta += 1;
  }
  assert(messages.length > 0, 'worklet did not produce a live frame');
  const firstMessage = messages[0];
  const first = firstMessage.value;
  const measuredBatchMs = first.pcm.byteLength / 2 / 16_000 * 1_000;
  const measuredInputFloorMs = sourceQuanta * quantum / 48_000 * 1_000;
  assert(measuredBatchMs <= 20, `PCM batch exceeds 20 ms (${measuredBatchMs})`);
  assert(measuredBatchMs === 20, `PCM batch floor changed unexpectedly (${measuredBatchMs})`);
  assert(measuredInputFloorMs >= 20 && measuredInputFloorMs < 25,
    `first frame capture floor is outside expected range (${measuredInputFloorMs})`);
  assert(first.startSample === 0 && first.endSample === 320, 'sample timing does not cover one live frame');
  assert(firstMessage.transfer?.includes(first.pcm), 'PCM buffer was not transferred');
}

function toneAmplitude(pcm, frequency) {
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = pcm[index] / 32_768;
    const phase = 2 * Math.PI * frequency * index / 16_000;
    real += sample * Math.cos(phase);
    imaginary -= sample * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / pcm.length;
}

function captureTone(frequency) {
  const { messages, worklet } = loadWorklet();
  let sourceIndex = 0;
  for (let quantum = 0; quantum < 160 && messages.length < 3; quantum += 1) {
    const input = new Float32Array(128);
    for (let index = 0; index < input.length; index += 1) {
      input[index] = 0.75 * Math.sin(2 * Math.PI * frequency * (sourceIndex + index) / 48_000);
    }
    worklet.process([[input]]);
    sourceIndex += input.length;
  }
  assert(messages.length >= 3, 'worklet tone replay did not produce enough frames');
  return new Int16Array(messages[2].value.pcm);
}

function verifyAntiAliasBehavior() {
  const passband = captureTone(4_000);
  const stopband = captureTone(12_000);
  const retained = toneAmplitude(passband, 4_000);
  const alias = toneAmplitude(stopband, 4_000);
  assert(retained > 0.7, `passband tone was attenuated (${retained})`);
  assert(alias < 0.02 && alias < retained * 0.03,
    `anti-alias rejection regressed (${alias} vs ${retained})`);
}

function verifyStorageStability() {
  const allocations = { float32: 0, float64: 0, int16: 0 };
  const counted = (Constructor, key) => new Proxy(Constructor, {
    construct(target, args) {
      allocations[key] += 1;
      return Reflect.construct(target, args, target);
    },
  });
  const messages = [];
  let Processor;
  class AudioWorkletProcessorStub {
    constructor() {
      this.port = { postMessage: (value, transfer) => messages.push({ value, transfer }) };
    }
  }
  vm.runInNewContext(workletSource, {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    Float32Array: counted(Float32Array, 'float32'),
    Float64Array: counted(Float64Array, 'float64'),
    Int16Array: counted(Int16Array, 'int16'),
    Math,
    sampleRate: 48_000,
    registerProcessor: (_name, constructor) => { Processor = constructor; },
  });
  const worklet = new Processor({ processorOptions: { targetSampleRate: 16_000, batchMs: 100 } });
  const initial = { ...allocations };
  const silence = new Float32Array(128);
  for (let index = 0; index < 37; index += 1) worklet.process([[silence]]);
  assert(messages.length === 0, '100 ms stability control unexpectedly emitted a frame');
  assert(JSON.stringify(allocations) === JSON.stringify(initial),
    'worklet allocated typed-array storage during render quanta');
}

function expectFailure(label, callback) {
  let failed = false;
  try {
    callback();
  } catch {
    failed = true;
  }
  assert(failed, `negative control did not fail: ${label}`);
}

validateStructure();
measureCaptureFloor();
verifyAntiAliasBehavior();
verifyStorageStability();

// These controls intentionally remove one contract clause. If any of them no
// longer fails, the oracle has become too permissive to protect the leaf.
expectFailure('40 ms live cadence', () => validateStructure({
  protocolSource: protocol.replace('LIVE_BATCH_MS = 20', 'LIVE_BATCH_MS = 40'),
}));
expectFailure('unbounded native backlog', () => validateStructure({
  adapterSource: adapter.replaceAll('bufferedAmount', 'removedNativeBacklog'),
}));
expectFailure('silent dropped ranges', () => validateStructure({
  adapterSource: adapter.replaceAll('recordAudioGap', 'removedGapRecorder'),
}));
expectFailure('removed anti-alias filter', () => validateStructure({
  worklet: workletSource.replace('this.lowpassSections = 4;', 'this.lowpassSections = 0;'),
}));

console.log('TRANSPORT_CONTRACT_PASSED');
