import { run } from './run-gate.mjs';

run('uv', ['run', 'pytest', '-q', 'tests/server/test_cadence.py']);
console.log('CADENCE_GATE_PASSED');
