import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/accessibility.test.tsx', 'tests/speechAdapter.test.tsx']);
console.log('ACCESSIBILITY_GATE_PASSED');
