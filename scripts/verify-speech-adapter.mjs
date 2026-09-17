import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/speechAdapter.test.tsx']);
console.log('SPEECH_ADAPTER_GATE_PASSED');
