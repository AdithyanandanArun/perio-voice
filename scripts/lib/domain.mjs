import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Bundles the TypeScript clinical domain so a plain Node script can run it.
 *
 * The evaluation harness must exercise the shipped pipeline, not a JavaScript
 * copy of it that can drift, so it imports the same modules the browser does.
 */
export async function loadDomain() {
  const result = await build({
    entryPoints: ['src/domain/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  const directory = mkdtempSync(join(tmpdir(), 'perio-domain-'));
  const file = join(directory, 'domain.mjs');
  writeFileSync(file, result.outputFiles[0].text, 'utf8');
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
