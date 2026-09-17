import { run } from './run-gate.mjs';

run('uv', ['run', 'pytest', '-q', 'tests/server/test_telemetry.py']);
console.log('TELEMETRY_GATE_PASSED');
