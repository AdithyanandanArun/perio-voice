import { readFileSync } from 'node:fs';

const architecture = readFileSync('ARCHITECTURE.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

const requiredArchitectureSections = [
  '## Runtime topology',
  '## WebSocket protocol v1',
  '## Latency budget',
  '## Backpressure and concurrency',
  '## Observability',
  '## Privacy and clinical safety boundary',
  '## Deployment profiles',
  '## Post-milestone build order',
  'Irrelevant-speech filtering',
  'Sequence protection',
  'Context-aware phonetic disambiguation',
  'Negation handling',
  'Natural corrections and repetitions',
  'Background-noise robustness',
  'Multiple-speaker handling',
  'Speaking-speed and cadence robustness',
  'Context and position recovery',
  'Dental terminology and accent robustness',
];
for (const marker of requiredArchitectureSections) {
  if (!architecture.includes(marker)) throw new Error(`ARCHITECTURE.md is missing: ${marker}`);
}
for (const marker of ['npm run setup', 'npm run dev', 'First model start', '/api/health', '/ws/asr']) {
  if (!readme.includes(marker)) throw new Error(`README.md is missing: ${marker}`);
}
if (packageJson.scripts.dev !== 'node scripts/dev.mjs') {
  throw new Error('The unified dev command is not configured.');
}
console.log('ARCHITECTURE_GATE_PASSED');
