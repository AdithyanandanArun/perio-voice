import { describe, expect, it } from 'vitest';
import { chartKey, emptyRecord } from '../src/domain/chart';
import {
  STATION_COUNT,
  advanceStation,
  createWorkflow,
  isStaleObservation,
  jumpToStation,
  quadrantOf,
  resumeStation,
  retreatStation,
  skipTooth,
  stationAt,
  stationIndexOf,
  workflowProgress,
} from '../src/domain/workflow';
import type { ClinicalContext, DepthTriple, PerioRecord, Surface } from '../src/domain/types';

function context(tooth = 1, surface: Surface = 'buccal'): ClinicalContext {
  return {
    tooth,
    surface,
    measurement: 'probing_depth',
    expectedValues: 3,
    position: 0,
    version: 1,
  };
}

function chartWith(tooth: number, surface: Surface, depths: DepthTriple) {
  const record: PerioRecord = {
    ...emptyRecord(tooth, surface),
    probingDepths: depths,
    updatedAt: 1,
  };
  return { [chartKey(tooth, surface)]: record };
}

describe('full-mouth station order', () => {
  it('covers every tooth on both surfaces exactly once', () => {
    expect(STATION_COUNT).toBe(64);
    const seen = new Set(
      Array.from({ length: STATION_COUNT }, (_, index) => {
        const station = stationAt(index);
        return `${station.tooth}-${station.surface}`;
      }),
    );
    expect(seen.size).toBe(64);
  });

  it('follows the all-buccal-then-all-lingual path between arches', () => {
    // Updated for the all-buccal-then-all-lingual order: the buccal sweep
    // (upper 1..16, lower 17..32) completes before any lingual station.
    expect(stationAt(0)).toEqual({ tooth: 1, surface: 'buccal' });
    expect(stationAt(15)).toEqual({ tooth: 16, surface: 'buccal' });
    expect(stationAt(16)).toEqual({ tooth: 17, surface: 'buccal' });
    expect(stationAt(31)).toEqual({ tooth: 32, surface: 'buccal' });
    expect(stationAt(32)).toEqual({ tooth: 1, surface: 'lingual' });
    expect(stationAt(63)).toEqual({ tooth: 32, surface: 'lingual' });
  });

  it('maps teeth to quadrants', () => {
    expect(quadrantOf(3)).toBe('UR');
    expect(quadrantOf(14)).toBe('UL');
    expect(quadrantOf(19)).toBe('LL');
    expect(quadrantOf(30)).toBe('LR');
  });
});

describe('workflow transitions', () => {
  it('advances and steps back along the sequence', () => {
    const workflow = createWorkflow(1, 'buccal');
    const forward = advanceStation(context(), workflow, {});
    expect(forward.context).toMatchObject({ tooth: 2, surface: 'buccal', version: 2 });

    const backward = retreatStation(forward.context, forward.workflow, {});
    expect(backward.context).toMatchObject({ tooth: 1, surface: 'buccal', version: 3 });
  });

  it('bumps the version on a location change but not while filling one station', () => {
    const workflow = createWorkflow(14, 'buccal');
    const same = jumpToStation(context(14), workflow, {}, { tooth: 14, surface: 'buccal' });
    expect(same.context.version).toBe(1);
    expect(same.changed).toBe(false);

    const moved = jumpToStation(context(14), workflow, {}, { tooth: 15 });
    expect(moved.context.version).toBe(2);
    expect(moved.changed).toBe(true);
  });

  it('skips an absent tooth and never returns to it while advancing', () => {
    const workflow = createWorkflow(1, 'buccal');
    const skipped = skipTooth(context(1), workflow, {}, 2);
    expect(skipped.workflow.skipped).toEqual([2]);

    const start = advanceStation(context(1), skipped.workflow, {});
    expect(start.context.tooth).toBe(3);
  });

  it('remembers an unfinished station so the clinician can resume it', () => {
    const workflow = createWorkflow(14, 'buccal');
    const charts = chartWith(14, 'buccal', [3, null, null]);
    const away = jumpToStation(context(14), workflow, charts, { tooth: 20 });
    expect(away.workflow.resumeStack).toEqual([stationIndexOf(14, 'buccal')]);
    expect(away.workflow.mode).toBe('manual');

    const back = resumeStation(away.context, away.workflow, charts);
    expect(back.context).toMatchObject({ tooth: 14, surface: 'buccal' });
    expect(back.workflow.resumeStack).toEqual([]);
    expect(back.workflow.mode).toBe('sequential');
    expect(back.context.position).toBe(1);
  });

  it('does not stack a resume point when the station was finished', () => {
    const workflow = createWorkflow(14, 'buccal');
    const charts = chartWith(14, 'buccal', [3, 4, 5]);
    const away = jumpToStation(context(14), workflow, charts, { tooth: 20 });
    expect(away.workflow.resumeStack).toEqual([]);
  });

  it('reports that there is nothing to resume rather than guessing', () => {
    const workflow = createWorkflow(14, 'buccal');
    const move = resumeStation(context(14), workflow, {});
    expect(move.changed).toBe(false);
    expect(move.message).toMatch(/no interrupted station/i);
  });

  it('refuses an out-of-range tooth without changing position', () => {
    const workflow = createWorkflow(14, 'buccal');
    const move = jumpToStation(context(14), workflow, {}, { tooth: 40 });
    expect(move.changed).toBe(false);
    expect(move.context.tooth).toBe(14);
    expect(move.message).toMatch(/between 1 and 32/i);
  });

  it('places the cursor on the first unfilled site of the station it arrives at', () => {
    const charts = chartWith(20, 'buccal', [3, 4, null]);
    const move = jumpToStation(context(14), createWorkflow(14, 'buccal'), charts, { tooth: 20 });
    expect(move.context.position).toBe(2);
  });
});

describe('stale observation guard', () => {
  it('flags a final that observed an older location version', () => {
    expect(isStaleObservation(3, 4)).toBe(true);
    expect(isStaleObservation(4, 4)).toBe(false);
    expect(isStaleObservation(null, 9)).toBe(false);
  });
});

describe('workflow progress', () => {
  it('counts completed sites and excludes skipped teeth from the denominator', () => {
    const charts = chartWith(1, 'buccal', [3, 4, 5]);
    const base = workflowProgress(context(1), createWorkflow(1, 'buccal'), charts);
    expect(base.totalSites).toBe(192);
    expect(base.completedSites).toBe(3);
    expect(base.completedStations).toBe(1);

    const skipped = skipTooth(context(1), createWorkflow(1, 'buccal'), charts, 5);
    const after = workflowProgress(context(1), skipped.workflow, charts);
    expect(after.totalSites).toBe(186);
    expect(after.skipped).toEqual([5]);
  });
});
