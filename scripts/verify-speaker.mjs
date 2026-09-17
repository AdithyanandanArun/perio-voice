import { run } from './run-gate.mjs';

run('uv', ['run', 'pytest', '-q', 'tests/server/test_speaker.py']);
run('uv', ['run', 'python', 'scripts/calibrate_speaker.py']);
console.log('SPEAKER_GATE_PASSED');
