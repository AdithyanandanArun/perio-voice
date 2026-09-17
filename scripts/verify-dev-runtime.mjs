import { spawn } from 'node:child_process';
import process from 'node:process';

const output = [];
const child = spawn(process.execPath, ['scripts/dev.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, ASR_MODEL: process.env.ASR_TEST_MODEL ?? 'tiny.en' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => output.push(chunk.toString()));
child.stderr.on('data', (chunk) => output.push(chunk.toString()));

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(url, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Development runtime exited early.\n${output.join('')}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && await predicate(response)) return;
    } catch {
      // Startup races are expected until both listeners are bound.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}.\n${output.join('')}`);
}

async function stopRuntime() {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function isUnavailable(url) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(400) });
    } catch {
      return true;
    }
    await delay(150);
  }
  return false;
}

try {
  await waitFor('http://127.0.0.1:8000/api/health', async (response) => {
    const health = await response.json();
    return typeof health.model === 'string' && typeof health.status === 'string';
  }, 90_000);
  await waitFor('http://127.0.0.1:5173', async (response) => {
    const html = await response.text();
    return html.includes('id="root"');
  }, 30_000);
} finally {
  await stopRuntime();
}

if (!await isUnavailable('http://127.0.0.1:8000/api/health')) {
  throw new Error('ASR service remained reachable after unified runtime shutdown.');
}
if (!await isUnavailable('http://127.0.0.1:5173')) {
  throw new Error('Web app remained reachable after unified runtime shutdown.');
}
console.log('DEV_RUNTIME_GATE_PASSED');
