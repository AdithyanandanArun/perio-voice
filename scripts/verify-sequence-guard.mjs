import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/sequenceGuard.test.ts']);
console.log('SEQUENCE_GUARD_GATE_PASSED');
