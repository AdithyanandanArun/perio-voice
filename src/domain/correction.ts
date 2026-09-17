/**
 * Natural corrections and repetitions.
 *
 * Clinicians correct themselves constantly — "four... no, five", "tooth
 * fourteen, sorry, fifteen", "repeat that, three four four". A naive pipeline
 * reads those as extra measurements, which both stores the wrong value and
 * shifts every later site.
 *
 * A correction is resolved against the journal, not against the transcript. It
 * names an existing write, replaces it in place in the chart, and records a new
 * journal entry that supersedes the old one. A correction that reaches back
 * past the active station is real but consequential, so it is confirmed rather
 * than applied silently.
 */

import { lastFilledPosition, measurementValues, recordAt } from './chart';
import { measurementEntries } from './journal';
import type { CorrectionTarget } from './grammar';
import type {
  ChartChange,
  ClinicalContext,
  JournalEntry,
  MeasurementType,
  PerioRecord,
  Surface,
} from './types';

/** How far back a spoken correction may reach, in milliseconds. */
export const CORRECTION_WINDOW_MS = 90_000;

export interface CorrectionPlan {
  outcome: 'apply' | 'confirm' | 'reject';
  tooth: number;
  surface: Surface;
  measurement: MeasurementType;
  siteIndex: number;
  previous: number | null;
  targetEntryId: number | null;
  reason: string;
}

export interface CorrectionRequest {
  journal: readonly JournalEntry[];
  charts: Readonly<Record<string, PerioRecord>>;
  context: ClinicalContext;
  measurement: MeasurementType;
  target: CorrectionTarget;
  value: number;
  now: number;
}

function rejected(context: ClinicalContext, measurement: MeasurementType, reason: string): CorrectionPlan {
  return {
    outcome: 'reject',
    tooth: context.tooth,
    surface: context.surface,
    measurement,
    siteIndex: -1,
    previous: null,
    targetEntryId: null,
    reason,
  };
}

/** The journal entry that last wrote a given site, so it can be superseded. */
export function entryForSite(
  journal: readonly JournalEntry[],
  tooth: number,
  surface: Surface,
  measurement: MeasurementType,
  siteIndex: number,
): JournalEntry | null {
  const field = measurement === 'recession' ? 'recession' : 'probingDepths';
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (entry.undone || entry.compensates !== null) continue;
    const match = entry.changes.some(
      (change) =>
        change.tooth === tooth
        && change.surface === surface
        && change.field === field
        && change.siteIndex === siteIndex,
    );
    if (match) return entry;
  }
  return null;
}

export function resolveCorrection(request: CorrectionRequest): CorrectionPlan {
  const { journal, charts, context, measurement, target, value, now } = request;
  const record = recordAt(charts, context.tooth, context.surface);

  if (target.scope === 'site' && target.siteIndex !== null) {
    const previous = measurementValues(record, measurement)[target.siteIndex] ?? null;
    return {
      outcome: 'apply',
      tooth: context.tooth,
      surface: context.surface,
      measurement,
      siteIndex: target.siteIndex,
      previous,
      targetEntryId: entryForSite(
        journal,
        context.tooth,
        context.surface,
        measurement,
        target.siteIndex,
      )?.id ?? null,
      reason: 'named site in the active context',
    };
  }

  const siteIndex = lastFilledPosition(record, measurement);
  if (siteIndex >= 0) {
    return {
      outcome: 'apply',
      tooth: context.tooth,
      surface: context.surface,
      measurement,
      siteIndex,
      previous: measurementValues(record, measurement)[siteIndex] ?? null,
      targetEntryId: entryForSite(journal, context.tooth, context.surface, measurement, siteIndex)?.id
        ?? null,
      reason: 'most recent value in the active context',
    };
  }

  // Nothing to correct here, so the clinician is reaching back past a station
  // boundary. That is a real construction, but it rewrites a location they have
  // already left, so it is offered for confirmation instead of applied.
  const delayed = findDelayedTarget(journal, measurement, now);
  if (delayed === null) {
    return rejected(
      context,
      measurement,
      'There is no probing depth to correct in the active context.',
    );
  }
  return {
    outcome: 'confirm',
    tooth: delayed.change.tooth,
    surface: delayed.change.surface as Surface,
    measurement,
    siteIndex: delayed.change.siteIndex ?? 0,
    previous: typeof delayed.change.after === 'number' ? delayed.change.after : null,
    targetEntryId: delayed.entry.id,
    reason: `reaches back to tooth ${delayed.change.tooth} ${delayed.change.surface as Surface}`,
  };
}

interface DelayedTarget {
  entry: JournalEntry;
  change: ChartChange;
}

function findDelayedTarget(
  journal: readonly JournalEntry[],
  measurement: MeasurementType,
  now: number,
): DelayedTarget | null {
  const field = measurement === 'recession' ? 'recession' : 'probingDepths';
  for (const entry of measurementEntries(journal)) {
    if (now - entry.occurredAt > CORRECTION_WINDOW_MS) return null;
    const changes = entry.changes.filter(
      (change) => change.field === field && change.surface !== null,
    );
    const change = changes[changes.length - 1];
    if (change !== undefined) return { entry, change };
  }
  return null;
}

export function describeCorrection(plan: CorrectionPlan, value: number, siteLabel: string): string {
  if (plan.previous === null) {
    return `Set ${siteLabel} to ${value} mm.`;
  }
  return `Corrected ${siteLabel} from ${plan.previous} to ${value} mm.`;
}
