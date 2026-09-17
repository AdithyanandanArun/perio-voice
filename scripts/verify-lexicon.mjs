import { run } from './run-gate.mjs';

run('npm', ['run', 'test:run', '--', 'tests/lexicon.test.ts']);
console.log('LEXICON_GATE_PASSED');
