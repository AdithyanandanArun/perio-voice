import { run } from './run-gate.mjs';

run('uv', ['run', 'ruff', 'check', 'server', 'tests/server', 'scripts/verify_model_runtime.py']);
run('uv', ['run', 'ruff', 'format', '--check', 'server', 'tests/server', 'scripts/verify_model_runtime.py']);
run('uv', ['run', 'mypy']);
run('uv', ['run', 'pytest', '-q', 'tests/server']);
run('npm', ['run', 'lint']);
run('npm', ['run', 'typecheck']);
run('npm', ['run', 'test:run']);
run('npm', ['run', 'build']);
console.log('QUALITY_GATE_PASSED');
