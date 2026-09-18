import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/autoChart.test.ts', '-t', 'automatic chart safety']);
console.log('AUTO_CHART_SAFETY_GATE_PASSED');
