import { run } from './run-gate.mjs';

run('uv', ['run', 'pytest', '-q', 'tests/server/test_api.py']);
console.log('ASR_API_GATE_PASSED');
