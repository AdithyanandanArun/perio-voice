import { readFileSync } from 'node:fs';

const readme = readFileSync('README.md', 'utf8');
const requiredSections = [
  /## Quick start/i,
  /## Supported clinical phrases/i,
  /## Runtime endpoints/i,
  /## Configuration/i,
  /## Verification/i,
  /## Project boundaries/i,
  /ARCHITECTURE\.md/i,
  /npm run dev/,
  /npm run setup/,
  /npm run test:run/,
  /correction/i,
  /latency/i,
];
const missing = requiredSections.filter((pattern) => !pattern.test(readme));
if (missing.length > 0) {
  throw new Error(`README is missing ${missing.length} required section or instruction markers.`);
}
console.log('DOCUMENTATION_GATE_PASSED');
