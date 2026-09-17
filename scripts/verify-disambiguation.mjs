import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/disambiguation.test.ts']);
console.log('DISAMBIGUATION_GATE_PASSED');
