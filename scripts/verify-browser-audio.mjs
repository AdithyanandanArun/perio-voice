import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/speechAdapter.test.tsx', 'tests/worklet.test.ts']);
console.log('BROWSER_AUDIO_GATE_PASSED');
