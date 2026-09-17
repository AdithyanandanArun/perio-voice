/**
 * Sequence protection.
 *
 * Grouped measurements are positional, so one inserted or dropped value does
 * not produce one wrong measurement — it produces every following measurement
 * at the wrong site. A small recognition error becomes a large structural
 * charting error.
 *
 * The guard therefore validates a whole candidate group against the sites that
 * are actually open and either accepts it completely or rejects it completely.
 * There is no partial write, because a partial write is precisely the state
 * from which the sequence drifts.
 */

import {
  MAX_DEPTH_MM,
  MAX_FURCATION_GRADE,
  MAX_MOBILITY_GRADE,
  MAX_RECESSION_MM,
  MIN_DEPTH_MM,
  MIN_RECESSION_MM,
  SITES_PER_STATION,
  type ClinicalContext,
  type MeasurementType,
  type PerioRecord,
} from './types';
import { lastFilledPosition, measurementValues, nextOpenPosition, siteName } from './chart';
import type { FindingAssertion } from './negation';
import type { Intent } from './grammar';

export type GuardOutcome = 'accept' | 'reject' | 'confirm';

export type GuardCode =
  | 'ok'
  | 'empty'
  | 'out_of_range'
  | 'overflow'
  | 'station_complete'
  | 'nothing_to_correct'
  | 'site_out_of_range'
  | 'overwrite'
  | 'wrong_length'
  | 'invalid_grade';

export interface GuardVerdict {
  outcome: GuardOutcome;
  code: GuardCode;
  reason: string;
  /** Site indices the values would occupy, in order. */
  placements: number[];
}

export function valueRange(measurement: MeasurementType): readonly [number, number] {
  return measurement === 'recession'
    ? [MIN_RECESSION_MM, MAX_RECESSION_MM]
    : [MIN_DEPTH_MM, MAX_DEPTH_MM];
}

function measurementLabel(measurement: MeasurementType): string {
  return measurement === 'recession' ? 'Recession' : 'Probing depths';
}

function accept(placements: number[]): GuardVerdict {
  return { outcome: 'accept', code: 'ok', reason: 'within the active sequence', placements };
}

function reject(code: GuardCode, reason: string): GuardVerdict {
  return { outcome: 'reject', code, reason, placements: [] };
}

function confirm(code: GuardCode, reason: string, placements: number[]): GuardVerdict {
  return { outcome: 'confirm', code, reason, placements };
}

function outOfRange(values: readonly number[], measurement: MeasurementType): boolean {
  const [min, max] = valueRange(measurement);
  return values.some((value) => !Number.isInteger(value) || value < min || value > max);
}

export function guardMeasurements(
  values: readonly number[],
  measurement: MeasurementType,
  siteIndex: number | null,
  context: ClinicalContext,
  record: PerioRecord,
): GuardVerdict {
  if (values.length === 0) return reject('empty', 'no values were recognized');
  const [min, max] = valueRange(measurement);
  if (outOfRange(values, measurement)) {
    return reject(
      'out_of_range',
      `${measurementLabel(measurement)} must be between ${min} and ${max} millimeters.`,
    );
  }

  if (siteIndex !== null) {
    if (siteIndex < 0 || siteIndex >= SITES_PER_STATION) {
      return reject('site_out_of_range', 'that site is not part of the active surface');
    }
    if (values.length !== 1) {
      return reject(
        'wrong_length',
        `Naming one site takes exactly one value; ${values.length} were heard.`,
      );
    }
    const existing = measurementValues(record, measurement)[siteIndex];
    const site = siteName(context.surface, siteIndex);
    if (existing !== null && existing !== values[0]) {
      return confirm(
        'overwrite',
        `${site} already holds ${existing} mm. Confirm replacing it with ${values[0]} mm.`,
        [siteIndex],
      );
    }
    return accept([siteIndex]);
  }

  const position = nextOpenPosition(record, measurement);
  if (position >= SITES_PER_STATION) {
    return reject(
      'station_complete',
      'The active three-site sequence is complete. Change context or say “repeat that” with three values.',
    );
  }
  const remaining = SITES_PER_STATION - position;
  if (values.length > remaining) {
    return reject(
      'overflow',
      `Expected ${remaining} more ${remaining === 1 ? 'value' : 'values'}; no depths were changed.`,
    );
  }
  return accept(values.map((_, offset) => position + offset));
}

export function guardReplacement(
  values: readonly number[],
  measurement: MeasurementType,
  context: ClinicalContext,
): GuardVerdict {
  const [min, max] = valueRange(measurement);
  if (values.length !== context.expectedValues) {
    return reject(
      'wrong_length',
      `A replacement sequence must contain exactly ${context.expectedValues} ${
        measurement === 'recession' ? 'recession values' : 'depths'
      } from ${min} to ${max} mm.`,
    );
  }
  if (outOfRange(values, measurement)) {
    return reject(
      'out_of_range',
      `A replacement sequence must contain exactly ${context.expectedValues} ${
        measurement === 'recession' ? 'recession values' : 'depths'
      } from ${min} to ${max} mm.`,
    );
  }
  return accept(values.map((_, index) => index));
}

export function guardCorrection(
  value: number,
  measurement: MeasurementType,
  siteIndex: number | null,
  record: PerioRecord,
): GuardVerdict {
  const target = siteIndex ?? lastFilledPosition(record, measurement);
  if (target < 0) {
    return reject(
      'nothing_to_correct',
      'There is no probing depth to correct in the active context.',
    );
  }
  if (target >= SITES_PER_STATION) {
    return reject('site_out_of_range', 'that site is not part of the active surface');
  }
  const [min, max] = valueRange(measurement);
  if (outOfRange([value], measurement)) {
    return reject(
      'out_of_range',
      `${measurementLabel(measurement)} must be between ${min} and ${max} millimeters.`,
    );
  }
  return accept([target]);
}

export function guardFindings(assertions: readonly FindingAssertion[]): GuardVerdict {
  for (const assertion of assertions) {
    if (assertion.grade === null) continue;
    const max = assertion.finding === 'furcation' ? MAX_FURCATION_GRADE : MAX_MOBILITY_GRADE;
    if (assertion.finding !== 'furcation' && assertion.finding !== 'mobility') continue;
    if (!Number.isInteger(assertion.grade) || assertion.grade < 0 || assertion.grade > max) {
      return reject(
        'invalid_grade',
        `${assertion.finding} grade must be between 0 and ${max}.`,
      );
    }
  }
  return accept([]);
}

/** Routes an intent to the rule that owns it. */
export function guardIntent(
  intent: Intent,
  context: ClinicalContext,
  record: PerioRecord,
): GuardVerdict {
  switch (intent.kind) {
    case 'measurements':
      return guardMeasurements(intent.values, intent.measurement, intent.siteIndex, context, record);
    case 'replace_sequence':
      return guardReplacement(intent.values, intent.measurement, context);
    case 'correction':
      return guardCorrection(intent.value, intent.measurement, intent.target.siteIndex, record);
    case 'findings':
      return guardFindings(intent.assertions);
    default:
      return accept([]);
  }
}

/**
 * Site-level alignment error between a charted station and what was spoken.
 * Used by the evaluation harness to separate "wrong value" from "right value in
 * the wrong place", which is the failure this guard exists to prevent.
 */
export function alignmentError(
  charted: readonly (number | null)[],
  expected: readonly (number | null)[],
): number {
  let mismatches = 0;
  for (let index = 0; index < Math.max(charted.length, expected.length); index += 1) {
    if ((charted[index] ?? null) !== (expected[index] ?? null)) mismatches += 1;
  }
  return mismatches;
}
