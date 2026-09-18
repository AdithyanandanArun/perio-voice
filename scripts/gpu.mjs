import { existsSync } from 'node:fs';
import process from 'node:process';

/**
 * `uv` arguments that keep the CUDA runtime wheels installed on a machine that
 * can use them. The service runs large-v3 on the GPU only when cuBLAS and cuDNN
 * load, and those come from the `gpu` extra; an exact `uv sync` without it
 * removes them and the service quietly falls back to the CPU recognizer. Machines
 * without an NVIDIA device skip the extra and its gigabyte of wheels.
 */
export function uvGpuArgs() {
  const hasNvidiaGpu = process.platform === 'linux' && existsSync('/dev/nvidia0');
  return hasNvidiaGpu ? ['--extra', 'gpu'] : [];
}
