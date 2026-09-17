import { run } from './run-gate.mjs';

run('uv', ['run', 'pytest', '-q', 'tests/server/test_audio.py', 'tests/server/test_session.py']);
console.log('SERVER_DOMAIN_GATE_PASSED');
