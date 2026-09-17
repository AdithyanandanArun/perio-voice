import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/workflow.test.tsx']);
console.log('WORKFLOW_GATE_PASSED');
