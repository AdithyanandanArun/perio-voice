import { run } from './run-gate.mjs';

// The test file contains both positive controls (a valid transaction must
// commit) and negative controls (duplicate/conflicting/stale inputs must not).
// Keeping this as a repository-owned oracle prevents the ledger from reducing
// transaction safety to a fixed-output smoke check.
run('npm', ['run', 'test:run', '--', 'tests/transactionSafety.test.ts']);
console.log('TRANSACTION_SAFETY_GATE_PASSED');
