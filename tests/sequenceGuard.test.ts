import { describe, expect, it } from 'vitest';
import { applyTranscript, createInitialSession, currentRecord } from '../src/domain/clinicalEngine';
import { emptyRecord } from '../src/domain/chart';
import {
  alignmentError,
  guardCorrection,
  guardMeasurements,
  guardReplacement,
  valueRange,
} from '../src/domain/sequenceGuard';
import type { ClinicalContext, ClinicalSession, DepthTriple, PerioRecord } from '../src/domain/types';

const context: ClinicalContext = {
  tooth: 14,
  surface: 'buccal',
  measurement: 'probing_depth',
  expectedValues: 3,
  position: 0,
  version: 1,
};

function record(depths: DepthTriple): PerioRecord {
  return { ...emptyRecord(14, 'buccal'), probingDepths: depths, updatedAt: depths.some((d) => d !== null) ? 1 : null };
}

/** Deterministic generator so a property failure is always reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function speak(session: ClinicalSession, values: number[], clock: number): ClinicalSession {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  return applyTranscript(session, values.map((value) => words[value]).join(' '), {
    startedAt: clock,
    observedAt: clock + 20,
  });
}

describe('sequence guard rules', () => {
  it('declares the value range each measurement accepts', () => {
    expect(valueRange('probing_depth')).toEqual([1, 12]);
    expect(valueRange('recession')).toEqual([0, 12]);
  });

  it('accepts a group that exactly fills the open sites', () => {
    const verdict = guardMeasurements([3, 4, 5], 'probing_depth', null, context, record([null, null, null]));
    expect(verdict).toMatchObject({ outcome: 'accept', placements: [0, 1, 2] });
  });

  it('accepts a shorter group and places it from the cursor', () => {
    const verdict = guardMeasurements([5], 'probing_depth', null, context, record([3, null, null]));
    expect(verdict).toMatchObject({ outcome: 'accept', placements: [1] });
  });

  it('rejects an inserted value as a unit rather than shifting later sites', () => {
    const verdict = guardMeasurements([3, 4, 5, 5], 'probing_depth', null, context, record([null, null, null]));
    expect(verdict).toMatchObject({ outcome: 'reject', code: 'overflow', placements: [] });
  });

  it('rejects a group that would overrun the sites the cursor has left', () => {
    const verdict = guardMeasurements([2, 3, 4], 'probing_depth', null, context, record([3, 5, null]));
    expect(verdict.outcome).toBe('reject');
    expect(verdict.reason).toContain('1 more value');
  });

  it('rejects a whole group when any single value is out of range', () => {
    const verdict = guardMeasurements([3, 13, 5], 'probing_depth', null, context, record([null, null, null]));
    expect(verdict).toMatchObject({ outcome: 'reject', code: 'out_of_range', placements: [] });
  });

  it('refuses to append to a finished station', () => {
    const verdict = guardMeasurements([4], 'probing_depth', null, context, record([3, 4, 5]));
    expect(verdict).toMatchObject({ outcome: 'reject', code: 'station_complete' });
  });

  it('asks before overwriting a named site that already holds a different value', () => {
    const verdict = guardMeasurements([6], 'probing_depth', 0, context, record([3, 4, 5]));
    expect(verdict).toMatchObject({ outcome: 'confirm', code: 'overwrite', placements: [0] });
  });

  it('writes a named site without asking when it is empty or unchanged', () => {
    expect(guardMeasurements([6], 'probing_depth', 2, context, record([3, 4, null])).outcome).toBe('accept');
    expect(guardMeasurements([5], 'probing_depth', 2, context, record([3, 4, 5])).outcome).toBe('accept');
  });

  it('requires a replacement sequence to be exactly the station length', () => {
    expect(guardReplacement([3, 4], 'probing_depth', context).outcome).toBe('reject');
    expect(guardReplacement([3, 4, 4], 'probing_depth', context).outcome).toBe('accept');
    expect(guardReplacement([3, 4, 13], 'probing_depth', context)).toMatchObject({ code: 'out_of_range' });
  });

  it('refuses a correction when nothing has been recorded yet', () => {
    expect(guardCorrection(3, 'probing_depth', null, record([null, null, null]))).toMatchObject({
      outcome: 'reject',
      code: 'nothing_to_correct',
    });
    expect(guardCorrection(3, 'probing_depth', null, record([4, null, null]))).toMatchObject({
      outcome: 'accept',
      placements: [0],
    });
  });

  it('measures site-level alignment error separately from value error', () => {
    expect(alignmentError([3, 4, 5], [3, 4, 5])).toBe(0);
    expect(alignmentError([3, 4, 6], [3, 4, 5])).toBe(1);
    // One dropped value shifts everything after it: three wrong sites, not one.
    expect(alignmentError([4, 5, null], [3, 4, 5])).toBe(3);
  });
});

describe('sequence integrity through the engine', () => {
  it('keeps a dropped value from shifting the next tooth into the gap', () => {
    // The clinician said "three four five"; the recognizer returned two values.
    let session = speak(createInitialSession(), [3, 5], 0);
    expect(currentRecord(session).probingDepths).toEqual([3, 5, null]);

    // Moving on without noticing must not let the next group fill the gap.
    session = speak(session, [2, 3, 4], 100);
    expect(currentRecord(session).probingDepths).toEqual([3, 5, null]);
    expect(session.history[0].kind).toBe('rejected');
  });

  it('never partially applies a group, for any sequence of spoken groups', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = seeded(seed);
      let session = createInitialSession();
      const expected: number[] = [];
      let rejections = 0;

      for (let utterance = 0; utterance < 6; utterance += 1) {
        const size = 1 + Math.floor(random() * 4);
        const values = Array.from({ length: size }, () => 1 + Math.floor(random() * 12));
        const remaining = 3 - expected.length;
        if (remaining === 0 || values.length > remaining) {
          rejections += 1;
        } else {
          expected.push(...values);
        }
        session = speak(session, values, utterance * 100);
      }

      const charted = currentRecord(session).probingDepths;
      const padded = [expected[0] ?? null, expected[1] ?? null, expected[2] ?? null];
      expect(charted, `seed ${seed}`).toEqual(padded);
      expect(
        session.history.filter((event) => event.kind === 'rejected').length,
        `seed ${seed}`,
      ).toBe(rejections);
    }
  });
});
