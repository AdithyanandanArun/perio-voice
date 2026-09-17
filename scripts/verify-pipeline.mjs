import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/pipeline.test.ts']);
console.log('PIPELINE_GATE_PASSED');
