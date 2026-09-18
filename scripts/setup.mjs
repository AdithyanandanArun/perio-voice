import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { uvGpuArgs } from './gpu.mjs';

const gpu = uvGpuArgs();

function run(args) {
  console.log(`$ uv ${args.join(' ')}`);
  const result = spawnSync('uv', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['sync', '--frozen', ...gpu]);
run(['run', ...gpu, 'python', 'scripts/fetch_grammar_model.py']);
// The recognizer the service will actually load: large-v3 (~3 GB) on a GPU,
// tiny.en otherwise. Fetching it here keeps the first `npm run dev` from
// spending minutes on a download behind "Loading model".
run(['run', ...gpu, 'python', 'scripts/fetch_whisper_model.py']);
