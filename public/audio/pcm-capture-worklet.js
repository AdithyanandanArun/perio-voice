class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions ?? {};
    this.targetSampleRate = config.targetSampleRate ?? 16000;
    this.batchSamples = Math.round(this.targetSampleRate * (config.batchMs ?? 100) / 1000);
    this.ratio = sampleRate / this.targetSampleRate;
    this.requiredSamples = Math.ceil(this.batchSamples * this.ratio) + 1;
    this.buffer = new Float32Array(this.requiredSamples + 256);
    this.bufferLength = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    if (this.bufferLength + input.length > this.buffer.length) {
      const expanded = new Float32Array(this.bufferLength + input.length + 256);
      expanded.set(this.buffer.subarray(0, this.bufferLength));
      this.buffer = expanded;
    }
    this.buffer.set(input, this.bufferLength);
    this.bufferLength += input.length;

    while (this.bufferLength >= this.requiredSamples) {
      const pcm = new Int16Array(this.batchSamples);
      let squareSum = 0;
      for (let index = 0; index < this.batchSamples; index += 1) {
        const position = index * this.ratio;
        const left = Math.floor(position);
        const fraction = position - left;
        const sample = this.buffer[left] * (1 - fraction) + this.buffer[left + 1] * fraction;
        const clipped = Math.max(-1, Math.min(1, sample));
        pcm[index] = clipped < 0 ? clipped * 32768 : clipped * 32767;
        squareSum += clipped * clipped;
      }
      const consumed = Math.floor(this.batchSamples * this.ratio);
      this.buffer.copyWithin(0, consumed, this.bufferLength);
      this.bufferLength -= consumed;
      this.port.postMessage(
        { pcm: pcm.buffer, level: Math.sqrt(squareSum / this.batchSamples) },
        [pcm.buffer],
      );
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
