import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/clinicalEngine.test.ts']);
console.log('DOMAIN_GATE_PASSED');
