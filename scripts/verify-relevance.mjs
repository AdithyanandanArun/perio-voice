import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/relevance.test.ts']);
console.log('RELEVANCE_GATE_PASSED');
