import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/autoChart.test.ts']);
console.log('AUTO_CHART_GATE_PASSED');
