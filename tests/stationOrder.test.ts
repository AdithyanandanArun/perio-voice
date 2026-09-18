import { describe, expect, it } from 'vitest';
import {
  STATION_ORDER,
  advanceStation,
  createWorkflow,
  retreatStation,
  skipTooth,
  stationAt,
  stationIndexOf,
} from '../src/domain/workflow';
import type { ClinicalContext, Surface } from '../src/domain/types';

/**
 * The owner's decision: ALL BUCCAL first (upper 1..16, then lower 17..32),
 * then ALL LINGUAL in the same sweep (upper 1..16, then lower 17..32). One
 * continuous "U" for buccal, then the same "U" for lingual — never a
 * zig-zag between surfaces tooth by tooth.
 */

function context(tooth: number, surface: Surface): ClinicalContext {
  return {
    tooth,
    surface,
    measurement: 'probing_depth',
    expectedValues: 3,
    position: 0,
    version: 1,
  };
}

function expectedStation(index: number): { tooth: number; surface: Surface } {
  if (index < 32) return { tooth: index + 1, surface: 'buccal' };
  return { tooth: index - 31, surface: 'lingual' };
}

describe('station order — all buccal then all lingual', () => {
  it('lays out the full 64-station order exactly: buccal 1..16, 17..32, then lingual 1..16, 17..32', () => {
    expect(STATION_ORDER.length).toBe(64);
    for (let index = 0; index < 64; index += 1) {
      expect(STATION_ORDER[index]).toEqual(expectedStation(index));
    }
    // Spot-check the four boundary stations explicitly, in plain language.
    expect(STATION_ORDER[0]).toEqual({ tooth: 1, surface: 'buccal' });
    expect(STATION_ORDER[15]).toEqual({ tooth: 16, surface: 'buccal' });
    expect(STATION_ORDER[16]).toEqual({ tooth: 17, surface: 'buccal' });
    expect(STATION_ORDER[31]).toEqual({ tooth: 32, surface: 'buccal' });
    expect(STATION_ORDER[32]).toEqual({ tooth: 1, surface: 'lingual' });
    expect(STATION_ORDER[47]).toEqual({ tooth: 16, surface: 'lingual' });
    expect(STATION_ORDER[48]).toEqual({ tooth: 17, surface: 'lingual' });
    expect(STATION_ORDER[63]).toEqual({ tooth: 32, surface: 'lingual' });
  });

  it('continuous charting crosses arches within buccal, then crosses into lingual', () => {
    // 16 buccal -> 17 buccal (upper-to-lower arch, still buccal)
    const atUpperBuccalEnd = advanceStation(
      context(16, 'buccal'),
      createWorkflow(16, 'buccal'),
      {},
    );
    expect(atUpperBuccalEnd.context).toMatchObject({ tooth: 17, surface: 'buccal' });

    // 32 buccal -> 1 lingual (the whole buccal sweep hands off to the lingual sweep)
    const atBuccalSweepEnd = advanceStation(
      context(32, 'buccal'),
      createWorkflow(32, 'buccal'),
      {},
    );
    expect(atBuccalSweepEnd.context).toMatchObject({ tooth: 1, surface: 'lingual' });
  });

  it('"next tooth" (advance) and "back" (retreat) both follow the buccal-to-lingual order', () => {
    const forward = advanceStation(context(32, 'buccal'), createWorkflow(32, 'buccal'), {});
    expect(forward.context).toMatchObject({ tooth: 1, surface: 'lingual' });

    const backward = retreatStation(forward.context, forward.workflow, {});
    expect(backward.context).toMatchObject({ tooth: 32, surface: 'buccal' });

    // Same check at the upper/lower arch boundary, still within buccal.
    const forward2 = advanceStation(context(16, 'buccal'), createWorkflow(16, 'buccal'), {});
    expect(forward2.context).toMatchObject({ tooth: 17, surface: 'buccal' });
    const backward2 = retreatStation(forward2.context, forward2.workflow, {});
    expect(backward2.context).toMatchObject({ tooth: 16, surface: 'buccal' });
  });

  it('a skipped tooth is skipped on both the buccal and the lingual pass', () => {
    const workflow = createWorkflow(1, 'buccal');
    const afterSkip = skipTooth(context(1, 'buccal'), workflow, {}, 2);
    expect(afterSkip.workflow.skipped).toEqual([2]);

    // Buccal pass: advancing from tooth 1 buccal must not stop at tooth 2 buccal.
    const pastBuccal = advanceStation(context(1, 'buccal'), afterSkip.workflow, {});
    expect(pastBuccal.context.tooth).toBe(3);
    expect(pastBuccal.context.surface).toBe('buccal');

    // Lingual pass: tooth 2 lingual must also be skipped over.
    const beforeLingualGap = advanceStation(
      context(1, 'lingual'),
      { ...afterSkip.workflow, stationIndex: stationIndexOf(1, 'lingual') },
      {},
    );
    expect(beforeLingualGap.context.tooth).toBe(3);
    expect(beforeLingualGap.context.surface).toBe('lingual');
  });

  it('the last station in the full-mouth order is tooth 32 lingual', () => {
    const last = STATION_ORDER[STATION_ORDER.length - 1];
    expect(last).toEqual({ tooth: 32, surface: 'lingual' });

    const atLast = advanceStation(context(32, 'lingual'), createWorkflow(32, 'lingual'), {});
    expect(atLast.changed).toBe(false);
    expect(atLast.message).toMatch(/last station/i);
  });

  it('stationAt and stationIndexOf agree with the defined order at the arch/surface boundaries', () => {
    expect(stationAt(15)).toEqual({ tooth: 16, surface: 'buccal' });
    expect(stationAt(16)).toEqual({ tooth: 17, surface: 'buccal' });
    expect(stationAt(31)).toEqual({ tooth: 32, surface: 'buccal' });
    expect(stationAt(32)).toEqual({ tooth: 1, surface: 'lingual' });

    expect(stationIndexOf(16, 'buccal')).toBe(15);
    expect(stationIndexOf(17, 'buccal')).toBe(16);
    expect(stationIndexOf(32, 'buccal')).toBe(31);
    expect(stationIndexOf(1, 'lingual')).toBe(32);
    expect(stationIndexOf(32, 'lingual')).toBe(63);
  });
});
