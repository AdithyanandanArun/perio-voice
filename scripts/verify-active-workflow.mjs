import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/activeWorkflow.test.tsx', 'tests/workflow.test.tsx']);
console.log('ACTIVE_WORKFLOW_GATE_PASSED');
