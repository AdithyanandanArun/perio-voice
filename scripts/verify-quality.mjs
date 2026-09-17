import { run } from './run-gate.mjs';

const PYTHON_SOURCES = ['server', 'evaluation', 'scripts', 'tests/server', 'tests/evaluation'];

run('uv', ['run', 'ruff', 'check', ...PYTHON_SOURCES]);
run('uv', ['run', 'ruff', 'format', '--check', ...PYTHON_SOURCES]);
run('uv', ['run', 'mypy']);
run('uv', ['run', 'pytest', '-q']);
run('npm', ['run', 'lint']);
run('npm', ['run', 'typecheck']);
run('npm', ['run', 'test:run']);
run('npm', ['run', 'build']);
console.log('QUALITY_GATE_PASSED');
