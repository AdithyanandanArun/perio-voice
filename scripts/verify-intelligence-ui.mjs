import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/intelligenceUi.test.tsx', 'tests/accessibility.test.tsx']);
console.log('INTELLIGENCE_UI_GATE_PASSED');
