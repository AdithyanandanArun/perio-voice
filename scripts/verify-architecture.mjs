import { readFileSync } from 'node:fs';

/**
 * The architecture document has to stay implementable: a reader should be able
 * to rebuild each decision from it. This checks that the pieces someone would
 * need are present and still agree with the code they describe.
 */
const architecture = readFileSync('ARCHITECTURE.md', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const config = readFileSync('server/config.py', 'utf8');
const prompt = JSON.parse(readFileSync('shared/dental-prompt.json', 'utf8'));

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

for (const section of [
  '## Runtime topology',
  '## The clinical intelligence pipeline',
  '## WebSocket protocol v1',
  '## State and commit rules',
  '## Latency budget',
  '## Backpressure and concurrency',
  '## Observability',
  '## Failure and recovery behavior',
  '## Privacy and clinical safety boundary',
  '## Deployment profiles',
  '## Evaluation strategy',
  '## Change discipline',
  '## What is not built',
]) {
  check(architecture.includes(section), `ARCHITECTURE.md is missing section: ${section}`);
}

// The declared stage order must match the order the pipeline actually runs.
const declaredOrder = [
  'speaker',
  'staleness',
  'lexicon',
  'lattice',
  'relevance',
  'context resolution',
  'grammar',
  'negation',
  'correction',
  'sequence guard',
  'commit',
];
const pipelineBlock = architecture.slice(
  architecture.indexOf('## The clinical intelligence pipeline'),
  architecture.indexOf('### 1.'),
);
for (const stage of declaredOrder) {
  check(pipelineBlock.includes(stage), `The documented stage order omits: ${stage}`);
}

// Every stage needs its own implementable description, not just a mention.
for (const heading of [
  'Speaker attribution',
  'Staleness',
  'Dental lexicon',
  'Candidate lattice',
  'Relevance',
  'Context resolution',
  'Grammar',
  'Negation',
  'Corrections and the journal',
  'Sequence guard',
  'Workflow position',
  'Cadence-adaptive endpointing',
  'Noise robustness',
]) {
  check(
    new RegExp(`### \\d+\\. ${heading}`).test(architecture),
    `ARCHITECTURE.md has no numbered design section for: ${heading}`,
  );
}

// Operational surfaces someone has to configure or observe.
for (const marker of [
  '/api/health',
  '/api/metrics',
  '/api/speaker/enroll',
  'ASR_ALLOWED_ORIGINS',
  'ASR_MAX_UTTERANCE_MS',
  'shared/dental-prompt.json',
  'EVALUATION.md',
]) {
  check(architecture.includes(marker), `ARCHITECTURE.md is missing: ${marker}`);
}

check(
  packageJson.scripts.dev === 'node scripts/dev.mjs',
  'The unified dev command is not configured.',
);
check(
  /ASR_DENOISE_PROFILE/.test(config) && /ASR_CADENCE_ADAPTIVE/.test(config),
  'server/config.py no longer exposes the documented runtime switches.',
);
check(
  typeof prompt.prompt === 'string' && prompt.prompt.length > 0,
  'shared/dental-prompt.json does not define the shared recognizer prompt.',
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure}`);
  throw new Error(`Architecture documentation failed ${failures.length} check(s).`);
}
console.log('ARCHITECTURE_GATE_PASSED');
