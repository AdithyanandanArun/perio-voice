/**
 * Full-mouth workflow state machine.
 *
 * A measurement is only meaningful attached to the right location, so position
 * is modelled explicitly rather than inferred from whatever was said last. The
 * mouth is a fixed, ordered list of stations; the clinician moves through it
 * sequentially, jumps out of it, skips absent teeth, and comes back.
 *
 * Every location change bumps `context.version`. Advancing through the three
 * sites of one station does not, because that is an ordinary consequence of
 * charting. A recognition result carries the version observed when the
 * clinician started speaking, so a final that was overtaken by a jump can be
 * rejected instead of landing in a location the clinician had already left.
 */

import {
  isStationComplete,
  nextOpenPosition,
  recordAt,
} from './chart';
import {
  MAX_TOOTH,
  MIN_TOOTH,
  type ClinicalContext,
  type PerioRecord,
  type Station,
  type Surface,
  type WorkflowState,
} from './types';

export type Quadrant = 'UR' | 'UL' | 'LL' | 'LR';

export const QUADRANT_RANGES: Record<Quadrant, readonly [number, number]> = {
  UR: [1, 8],
  UL: [9, 16],
  LL: [17, 24],
  LR: [25, 32],
};

export const QUADRANT_LABELS: Record<Quadrant, string> = {
  UR: 'upper right',
  UL: 'upper left',
  LL: 'lower left',
  LR: 'lower right',
};

function range(from: number, to: number): number[] {
  const step = from <= to ? 1 : -1;
  const values: number[] = [];
  for (let value = from; step > 0 ? value <= to : value >= to; value += step) values.push(value);
  return values;
}

/**
 * The conventional serpentine path: across the maxillary arch on the buccal,
 * back along the lingual, then the same for the mandibular arch. Charting in a
 * fixed order is what makes "next", "back" and "resume" unambiguous.
 */
function buildStationOrder(): Station[] {
  const stations: Station[] = [];
  const push = (teeth: number[], surface: Surface): void => {
    for (const tooth of teeth) stations.push({ tooth, surface });
  };
  push(range(1, 16), 'buccal');
  push(range(16, 1), 'lingual');
  push(range(17, 32), 'buccal');
  push(range(32, 17), 'lingual');
  return stations;
}

export const STATION_ORDER: readonly Station[] = buildStationOrder();
export const STATION_COUNT = STATION_ORDER.length;

export function stationAt(index: number): Station {
  const clamped = Math.max(0, Math.min(STATION_COUNT - 1, index));
  return STATION_ORDER[clamped];
}

export function stationIndexOf(tooth: number, surface: Surface): number {
  const index = STATION_ORDER.findIndex(
    (station) => station.tooth === tooth && station.surface === surface,
  );
  return index === -1 ? 0 : index;
}

export function quadrantOf(tooth: number): Quadrant {
  for (const [quadrant, [from, to]] of Object.entries(QUADRANT_RANGES) as [Quadrant, readonly [number, number]][]) {
    if (tooth >= from && tooth <= to) return quadrant;
  }
  return 'UR';
}

export function isValidTooth(tooth: number): boolean {
  return Number.isInteger(tooth) && tooth >= MIN_TOOTH && tooth <= MAX_TOOTH;
}

export function createWorkflow(tooth: number, surface: Surface): WorkflowState {
  return { stationIndex: stationIndexOf(tooth, surface), mode: 'sequential', skipped: [], resumeStack: [] };
}

export interface WorkflowMove {
  context: ClinicalContext;
  workflow: WorkflowState;
  message: string;
  changed: boolean;
}

interface MoveOptions {
  mode?: WorkflowState['mode'];
  skipped?: number[];
  resumeStack?: number[];
  message?: string;
}

const MAX_RESUME_DEPTH = 8;

function positionFor(record: PerioRecord, context: ClinicalContext): number {
  return nextOpenPosition(record, context.measurement);
}

/** Moves to a station index and bumps the version only on a real location change. */
export function moveToStation(
  context: ClinicalContext,
  workflow: WorkflowState,
  charts: Readonly<Record<string, PerioRecord>>,
  index: number,
  options: MoveOptions = {},
): WorkflowMove {
  const target = stationAt(index);
  const changed = target.tooth !== context.tooth || target.surface !== context.surface;
  const record = recordAt(charts, target.tooth, target.surface);
  const nextContext: ClinicalContext = {
    ...context,
    tooth: target.tooth,
    surface: target.surface,
    position: positionFor(record, context),
    version: changed ? context.version + 1 : context.version,
  };
  return {
    context: nextContext,
    workflow: {
      stationIndex: clampIndex(index),
      mode: options.mode ?? workflow.mode,
      skipped: options.skipped ?? workflow.skipped,
      resumeStack: options.resumeStack ?? workflow.resumeStack,
    },
    message:
      options.message
      ?? `Context moved to tooth ${target.tooth}, ${target.surface}.`,
    changed,
  };
}

function clampIndex(index: number): number {
  return Math.max(0, Math.min(STATION_COUNT - 1, index));
}

function nextChartableIndex(from: number, step: number, skipped: readonly number[]): number | null {
  for (let index = from + step; index >= 0 && index < STATION_COUNT; index += step) {
    if (!skipped.includes(STATION_ORDER[index].tooth)) return index;
  }
  return null;
}

export function advanceStation(
  context: ClinicalContext,
  workflow: WorkflowState,
  charts: Readonly<Record<string, PerioRecord>>,
): WorkflowMove {
  const index = nextChartableIndex(workflow.stationIndex, 1, workflow.skipped);
  if (index === null) {
    return {
      context,
      workflow,
      message: 'The full-mouth sequence is already at its last station.',
      changed: false,
    };
  }
  const station = stationAt(index);
  return moveToStation(context, workflow, charts, index, {
    mode: 'sequential',
    message: `Advanced to tooth ${station.tooth}, ${station.surface}.`,
  });
}

export function retreatStation(
  context: ClinicalContext,
  workflow: WorkflowState,
  charts: Readonly<Record<string, PerioRecord>>,
): WorkflowMove {
  const index = nextChartableIndex(workflow.stationIndex, -1, workflow.skipped);
  if (index === null) {
    return {
      context,
      workflow,
      message: 'The full-mouth sequence is already at its first station.',
      changed: false,
    };
  }
  const station = stationAt(index);
  return moveToStation(context, workflow, charts, index, {
    mode: 'sequential',
    message: `Stepped back to tooth ${station.tooth}, ${station.surface}.`,
  });
}

/** Marks a tooth absent and moves past every station belonging to it. */
export function skipTooth(
  context: ClinicalContext,
  workflow: WorkflowState,
  charts: Readonly<Record<string, PerioRecord>>,
  tooth: number = context.tooth,
): WorkflowMove {
  if (!isValidTooth(tooth)) {
    return { context, workflow, message: 'A skip needs a tooth number from 1 to 32.', changed: false };
  }
  const skipped = workflow.skipped.includes(tooth) ? workflow.skipped : [...workflow.skipped, tooth];
  let index: number | null = workflow.stationIndex;
  if (STATION_ORDER[workflow.stationIndex].tooth === tooth) {
    index = nextChartableIndex(workflow.stationIndex, 1, skipped);
  }
  if (index === null) {
    return {
      context,
      workflow: { ...workflow, skipped },
      message: `Tooth ${tooth} marked absent; no later station remains.`,
      changed: false,
    };
  }
  const station = stationAt(index);
  return moveToStation(context, { ...workflow, skipped }, charts, index, {
    mode: 'sequential',
    skipped,
    message: `Tooth ${tooth} marked absent; moved to tooth ${station.tooth}, ${station.surface}.`,
  });
}

export function unskipTooth(workflow: WorkflowState, tooth: number): WorkflowState {
  return { ...workflow, skipped: workflow.skipped.filter((value) => value !== tooth) };
}

/**
 * An explicit jump. If the clinician leaves an unfinished station, the station
 * is remembered so "resume" can return to exactly where charting stopped.
 */
export function jumpToStation(
  context: ClinicalContext,
  workflow: WorkflowState,
  charts: Readonly<Record<string, PerioRecord>>,
  patch: { tooth?: number; surface?: Surface },
): WorkflowMove {
  const tooth = patch.tooth ?? context.tooth;
  const surface = patch.surface ?? context.surface;
  if (!isValidTooth(tooth)) {
    return {
      context,
      workflow,
      message: 'Tooth number must be between 1 and 32.',
      changed: false,
    };
  }
  const index = stationIndexOf(tooth, surface);
  if (index === workflow.stationIndex) {
    return moveToStation(context, workflow, charts, index, {
      message: `Already at tooth ${tooth}, ${surface}.`,
    });
  }
  const current = recordAt(charts, context.tooth, context.surface);
  const leavingUnfinished = !isStationComplete(current, context.measurement);
  const resumeStack = leavingUnfinished
    ? [...workflow.resumeStack, workflow.stationIndex].slice(-MAX_RESUME_DEPTH)
    : workflow.resumeStack;
  return moveToStation(context, workflow, charts, index, {
    mode: 'manual',
    resumeStack,
    message: `Context moved to tooth ${tooth}, ${surface}.`,
  });
}

export function resumeStation(
  context: ClinicalContext,
  workflow: WorkflowState,
  charts: Readonly<Record<string, PerioRecord>>,
): WorkflowMove {
  if (workflow.resumeStack.length === 0) {
    return {
      context,
      workflow,
      message: 'There is no interrupted station to resume.',
      changed: false,
    };
  }
  const resumeStack = workflow.resumeStack.slice(0, -1);
  const index = workflow.resumeStack[workflow.resumeStack.length - 1];
  const station = stationAt(index);
  return moveToStation(context, workflow, charts, index, {
    mode: resumeStack.length === 0 ? 'sequential' : 'manual',
    resumeStack,
    message: `Resumed tooth ${station.tooth}, ${station.surface}.`,
  });
}

/** True when an utterance observed a location the clinician has since left. */
export function isStaleObservation(observedVersion: number | null, currentVersion: number): boolean {
  return observedVersion !== null && observedVersion < currentVersion;
}

export interface WorkflowProgress {
  stationIndex: number;
  stationCount: number;
  completedStations: number;
  completedSites: number;
  totalSites: number;
  skipped: number[];
  quadrant: Quadrant;
  resumable: boolean;
}

export function workflowProgress(
  context: ClinicalContext,
  workflow: WorkflowState,
  charts: Readonly<Record<string, PerioRecord>>,
): WorkflowProgress {
  let completedStations = 0;
  let completedSites = 0;
  for (const station of STATION_ORDER) {
    if (workflow.skipped.includes(station.tooth)) continue;
    const record = recordAt(charts, station.tooth, station.surface);
    const filled = record[context.measurement === 'recession' ? 'recession' : 'probingDepths'].filter(
      (value) => value !== null,
    ).length;
    completedSites += filled;
    if (filled === 3) completedStations += 1;
  }
  const active = STATION_ORDER.filter((station) => !workflow.skipped.includes(station.tooth));
  return {
    stationIndex: workflow.stationIndex,
    stationCount: active.length,
    completedStations,
    completedSites,
    totalSites: active.length * 3,
    skipped: [...workflow.skipped].sort((a, b) => a - b),
    quadrant: quadrantOf(context.tooth),
    resumable: workflow.resumeStack.length > 0,
  };
}
