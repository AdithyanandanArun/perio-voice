import { existsSync, readdirSync, statSync } from 'node:fs';
import { run } from './run-gate.mjs';

run('npm', ['run', 'build']);
if (!existsSync('dist/index.html') || statSync('dist/index.html').size === 0) {
  throw new Error('Production build did not create a non-empty dist/index.html.');
}
const assets = existsSync('dist/assets') ? readdirSync('dist/assets') : [];
if (!assets.some((file) => file.endsWith('.js')) || !assets.some((file) => file.endsWith('.css'))) {
  throw new Error('Production build is missing compiled JavaScript or CSS assets.');
}
console.log('BUILD_GATE_PASSED');
