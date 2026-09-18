// @vitest-environment node
//
// evaluate-clinical.mjs imports esbuild (via scripts/lib/domain.mjs) to bundle
// the production domain for a plain Node script; esbuild's own environment
// check fails inside vitest's default jsdom environment, so this file runs
// under the plain 'node' environment instead.
import { describe, expect, it } from 'vitest';
import { createInitialSession } from '../src/domain/clinicalEngine';
import { advanceStation, STATION_ORDER, stationIndexOf } from '../src/domain/workflow';
// Typed by tests/evaluate-clinical.d.ts: `scripts/**` is plain Node
// (allowJs is off for this project), so its export is typed by hand there
// instead of left implicitly 'any'.
import { main as runEvaluationHarness } from '../scripts/evaluate-clinical.mjs';

describe('a new exam starts at the first station of the full-mouth sweep', () => {
  it("starts the context at STATION_ORDER[0] (tooth 1 buccal)", () => {
    const session = createInitialSession();
    expect(STATION_ORDER[0]).toEqual({ tooth: 1, surface: 'buccal' });
    expect(session.context.tooth).toBe(STATION_ORDER[0].tooth);
    expect(session.context.surface).toBe(STATION_ORDER[0].surface);
  });

  it("keeps the workflow's stationIndex 0 consistent with the starting context, and advances to tooth 2 buccal", () => {
    const session = createInitialSession();
    // The workflow's own idea of "where we are" must agree with the context,
    // and both must be the sweep's first station -- never derived separately.
    expect(session.workflow.stationIndex).toBe(0);
    expect(session.workflow.stationIndex).toBe(stationIndexOf(session.context.tooth, session.context.surface));

    const move = advanceStation(session.context, session.workflow, session.charts);
    expect(move.context.tooth).toBe(2);
    expect(move.context.surface).toBe('buccal');
  });

  it('pins the evaluation harness scenarios that declare no start to tooth 14 buccal, not the product default', async () => {
    // The harness must not silently inherit the product's own starting
    // station (tooth 1 buccal) for the 78/86 corpus cases and 45/52 phrase
    // scenarios that were authored assuming tooth 14 buccal. Running the gate
    // end to end, exactly as `node scripts/evaluate-clinical.mjs --gate`
    // does, both proves the pin is wired in and guards against someone
    // deleting it: the corpus's expectations name tooth 14 explicitly, so
    // losing the pin would surface as a wrong exact-match count here.
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => {
      lines.push(line);
    };
    const originalExitCode = process.exitCode;
    try {
      const status = await runEvaluationHarness(['--gate']);
      expect(status).toBe(0);
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
    }
    const output = lines.join('\n');
    expect(output).toContain('CLINICAL_EVAL_GATE_PASSED');
    expect(output).toContain('86/86');
    expect(output).toContain('0/24');
  });
});
