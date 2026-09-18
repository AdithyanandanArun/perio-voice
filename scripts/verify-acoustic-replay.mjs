import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';

const manifest = JSON.parse(readFileSync('evaluation/fixtures/dental/phrases.json', 'utf8'));
const utterances = manifest.scenarios.flatMap((scenario) => scenario.utterances);
const expectedIds = new Set(utterances.map((utterance) => utterance.id));
const stimulusDirectory = 'evaluation/fixtures/dental/tts';
const stimulusManifest = JSON.parse(readFileSync(`${stimulusDirectory}/manifest.json`, 'utf8'));
if (stimulusManifest.schemaVersion !== 1 || stimulusManifest.voice !== 'en_US-lessac-medium') {
  throw new Error('Piper stimulus manifest has an incompatible schema or voice');
}
const stimulusFiles = readdirSync(stimulusDirectory).filter((name) => name.endsWith('.wav'));
const actualIds = new Set(stimulusFiles.map((name) => name.slice(0, -4)));
const missing = [...expectedIds].filter((id) => !actualIds.has(id));
const extra = [...actualIds].filter((id) => !expectedIds.has(id));
if (missing.length || extra.length) {
  throw new Error(`Piper stimulus inventory mismatch; missing=${missing.join(',')} extra=${extra.join(',')}`);
}
for (const name of stimulusFiles) {
  const wav = readFileSync(`${stimulusDirectory}/${name}`);
  const utteranceId = name.slice(0, -4);
  const utterance = utterances.find((candidate) => candidate.id === utteranceId);
  const record = stimulusManifest.records?.[utteranceId];
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  if (wav.length < 45
      || wav.toString('ascii', 0, 4) !== 'RIFF'
      || wav.toString('ascii', 8, 12) !== 'WAVE'
      || wav.readUInt16LE(20) !== 1
      || wav.readUInt16LE(22) !== 1
      || wav.readUInt16LE(34) !== 16
      || wav.readUInt32LE(24) < 16_000) {
    throw new Error(`${name} is not a usable mono PCM16 Piper stimulus`);
  }
  if (!utterance
      || record?.promptSha256 !== digest(utterance.prompt)
      || record?.wavSha256 !== digest(wav)) {
    throw new Error(`${name} is stale relative to its prompt or recorded digest`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return;
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

run(process.execPath, [
  'node_modules/vitest/vitest.mjs',
  'run',
  'tests/acousticReplay.test.ts',
  'tests/fixtureRecorder.test.tsx',
  'tests/speechAdapter.test.tsx',
  '--reporter=dot',
]);
run('uv', ['run', 'pytest', '-q', 'tests/server/test_api.py']);

console.log('ACOUSTIC_REPLAY_GATE_PASSED');
