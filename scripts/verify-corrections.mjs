import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/corrections.test.ts']);
console.log('CORRECTIONS_GATE_PASSED');
