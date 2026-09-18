import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/autoChartUi.test.tsx']);
console.log('AUTO_CHART_UI_GATE_PASSED');
