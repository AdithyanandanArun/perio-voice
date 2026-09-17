import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('dental transcript clinical evaluation', () => {
  it('passes the deterministic bridge verifier and its negative controls', () => {
    const verification = spawnSync(
      process.execPath,
      ['scripts/verify-dental-evaluation.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
      },
    );

    expect(verification.status, verification.stderr || verification.stdout).toBe(0);
    expect(verification.stdout).toContain('DENTAL_EVALUATION_BRIDGE_PASSED');
  }, 35_000);
});
