class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions ?? {};
    this.targetSampleRate = config.targetSampleRate ?? 16000;
    const requestedBatchMs = Number.isFinite(config.batchMs) && config.batchMs > 0
      ? config.batchMs
      : 40;
    this.batchSamples = Math.max(1, Math.round(this.targetSampleRate * requestedBatchMs / 1000));
    this.ratio = sampleRate / this.targetSampleRate;
    this.requiredSamples = Math.ceil(this.batchSamples * this.ratio) + 1;
    this.buffer = new Float32Array(this.requiredSamples + 256);
    this.bufferLength = 0;
    this.sampleOffset = 0;

    // Four biquads form an eighth-order Butterworth low-pass. At a 16 kHz
    // output rate, the cutoff is 7.6 kHz: close to the retained Nyquist band,
    // with enough rejection to keep higher input frequencies from folding
    // into speech frequencies during decimation.
    this.lowpassSections = 4;
    this.lowpassCoefficients = new Float64Array(this.lowpassSections * 5);
    this.lowpassState = new Float64Array(this.lowpassSections * 2);
    const cutoff = Math.min(this.targetSampleRate * 0.475, sampleRate * 0.475);
    const angularFrequency = 2 * Math.PI * cutoff / sampleRate;
    const cosine = Math.cos(angularFrequency);
    const sine = Math.sin(angularFrequency);

    for (let section = 0; section < this.lowpassSections; section += 1) {
      const q = 1 / (2 * Math.cos(
        Math.PI * (2 * section + 1) / (this.lowpassSections * 4),
      ));
      const alpha = sine / (2 * q);
      const normalize = 1 / (1 + alpha);
      const coefficientOffset = section * 5;
      this.lowpassCoefficients[coefficientOffset] = (1 - cosine) * 0.5 * normalize;
      this.lowpassCoefficients[coefficientOffset + 1] = (1 - cosine) * normalize;
      this.lowpassCoefficients[coefficientOffset + 2] =
        this.lowpassCoefficients[coefficientOffset];
      this.lowpassCoefficients[coefficientOffset + 3] = -2 * cosine * normalize;
      this.lowpassCoefficients[coefficientOffset + 4] = (1 - alpha) * normalize;
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    if (this.bufferLength + input.length > this.buffer.length) {
      const expanded = new Float32Array(this.bufferLength + input.length + 256);
      expanded.set(this.buffer.subarray(0, this.bufferLength));
      this.buffer = expanded;
    }
    const coefficients = this.lowpassCoefficients;
    const state = this.lowpassState;
    let writeIndex = this.bufferLength;
    for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) {
      let filtered = input[inputIndex];
      for (let section = 0; section < this.lowpassSections; section += 1) {
        const coefficientOffset = section * 5;
        const stateOffset = section * 2;
        const output = coefficients[coefficientOffset] * filtered + state[stateOffset];
        state[stateOffset] = coefficients[coefficientOffset + 1] * filtered
          - coefficients[coefficientOffset + 3] * output
          + state[stateOffset + 1];
        state[stateOffset + 1] = coefficients[coefficientOffset + 2] * filtered
          - coefficients[coefficientOffset + 4] * output;
        filtered = output;
      }
      this.buffer[writeIndex] = filtered;
      writeIndex += 1;
    }
    this.bufferLength = writeIndex;

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
      const startSample = this.sampleOffset;
      this.sampleOffset += this.batchSamples;
      this.port.postMessage(
        {
          pcm: pcm.buffer,
          level: Math.sqrt(squareSum / this.batchSamples),
          sampleRate: this.targetSampleRate,
          startSample,
          endSample: this.sampleOffset,
        },
        [pcm.buffer],
      );
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
