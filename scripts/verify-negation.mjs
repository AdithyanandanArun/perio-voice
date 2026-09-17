import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/negation.test.ts']);
console.log('NEGATION_GATE_PASSED');
