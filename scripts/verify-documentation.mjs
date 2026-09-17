import { readFileSync } from 'node:fs';

/**
 * Documentation is a gate because an undocumented capability is not deliverable.
 * This checks that each shipped stage, each runtime surface a user has to touch,
 * and the honest limits of the evaluation are actually written down.
 */
const readme = readFileSync('README.md', 'utf8');
const architecture = readFileSync('ARCHITECTURE.md', 'utf8');
const evaluation = readFileSync('EVALUATION.md', 'utf8');

const failures = [];

function require(label, source, markers) {
  for (const marker of markers) {
    const found = marker instanceof RegExp ? marker.test(source) : source.includes(marker);
    if (!found) failures.push(`${label} is missing: ${marker}`);
  }
}

require('README.md', readme, [
  /## Quick start/i,
  /## Supported clinical speech/i,
  /## Runtime endpoints/i,
  /## Configuration/i,
  /## Verification/i,
  /## Evaluation/i,
  /## Troubleshooting/i,
  /## Project boundaries/i,
  'npm run setup',
  'npm run dev',
  'First model start',
  '/api/health',
  '/api/metrics',
  '/api/speaker/enroll',
  '/ws/asr',
  'ARCHITECTURE.md',
  'EVALUATION.md',
  'GATES.md',
  'ASR_DENOISE_PROFILE',
  'ASR_ENGINE',
  'ASR_MIN_FINAL_MS',
  // The recognizer choice has to be justified where someone configuring it looks.
  'grammar-constrained',
  'ASR_SPEAKER_ACCEPT',
  'ASR_MIN_END_SILENCE_MS',
  'scripts/evaluate-clinical.mjs',
  'scripts/evaluate_acoustic.py',
  'scripts/verify-quality.mjs',
  /not a medical device/i,
]);

require('ARCHITECTURE.md', architecture, [
  '## Runtime topology',
  '## The clinical intelligence pipeline',
  '## WebSocket protocol v1',
  '## Latency budget',
  '## Backpressure and concurrency',
  '## Observability',
  '## Failure and recovery behavior',
  '## Privacy and clinical safety boundary',
  '## Deployment profiles',
  '## Evaluation strategy',
  '## Change discipline',
  '## What is not built',
  // Every capability from the original build order, now as delivered design.
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
]);

require('EVALUATION.md', evaluation, [
  /## Acoustic tier/i,
  /## Clinical tier/i,
  /## Speaker calibration/i,
  /### Cohorts/i,
  /### Metrics and thresholds/i,
  /## Reporting a change/i,
  'False chart entry rate',
  'Site alignment errors',
  'word error rate',
  // The limits have to be stated, not just the numbers.
  'does and does not establish',
  // The speaker finding is negative; it must be stated, not merely implied.
  'does not separate speakers',
  'Model size is not the variable',
]);

if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure}`);
  throw new Error(`Documentation is missing ${failures.length} required marker(s).`);
}
console.log('DOCUMENTATION_GATE_PASSED');
