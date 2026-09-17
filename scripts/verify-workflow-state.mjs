import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/workflowState.test.ts']);
console.log('WORKFLOW_STATE_GATE_PASSED');
