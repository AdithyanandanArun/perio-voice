import { spawn } from 'node:child_process';
import process from 'node:process';

import { uvGpuArgs } from './gpu.mjs';

const gpuExtra = uvGpuArgs();

const children = new Set();
let closing = false;

function launch(label, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  children.add(child);
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!closing && code !== 0) {
      console.error(`${label} exited unexpectedly (${signal ?? code}).`);
      void shutdown(code ?? 1);
    }
  });
  child.once('error', (error) => {
    console.error(`Could not start ${label}: ${error.message}`);
    void shutdown(1);
  });
  return child;
}

async function shutdown(exitCode = 0) {
  if (closing) return;
  closing = true;
  const activeChildren = [...children];
  for (const child of activeChildren) child.kill('SIGTERM');
  await Promise.all(
    activeChildren.map(
      (child) => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      }),
    ),
  );
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

launch('ASR service', 'uv', [
  'run',
  ...gpuExtra,
  'uvicorn',
  'server.app:app',
  '--host',
  '127.0.0.1',
  '--port',
  '8000',
  '--reload',
]);
launch('web app', process.execPath, ['node_modules/vite/bin/vite.js']);
