/**
 * Append-only clinical journal.
 *
 * Corrections and undo never edit a value in place. Every write is recorded as
 * a change with its previous value, and reversing a write appends a
 * compensating entry rather than deleting history. That is what makes a
 * correction auditable: the record shows what was heard, what was written, and
 * what replaced it.
 */

import { chartKey, emptyRecord, emptyTooth } from './chart';
import type {
  ChartChange,
  DepthTriple,
  JournalEntry,
  PerioRecord,
  ToothRecord,
} from './types';

export interface ChartState {
  charts: Record<string, PerioRecord>;
  teeth: Record<number, ToothRecord>;
}

const MEASUREMENT_FIELDS = new Set(['probingDepths', 'recession']);
const RECORD_FLAGS = new Set(['bleeding', 'suppuration', 'plaque', 'calculus']);

export function applyChange(state: ChartState, change: ChartChange, at: number): ChartState {
  if (change.surface !== null && (MEASUREMENT_FIELDS.has(change.field) || RECORD_FLAGS.has(change.field))) {
    const key = chartKey(change.tooth, change.surface);
    const existing = state.charts[key] ?? emptyRecord(change.tooth, change.surface);
    let updated: PerioRecord;
    if (MEASUREMENT_FIELDS.has(change.field)) {
      const field = change.field === 'recession' ? 'recession' : 'probingDepths';
      const values: DepthTriple = [...existing[field]];
      const index = change.siteIndex ?? 0;
      values[index] = typeof change.after === 'number' ? change.after : null;
      updated = { ...existing, [field]: values, updatedAt: at };
    } else {
      const field = change.field as 'bleeding' | 'suppuration' | 'plaque' | 'calculus';
      updated = {
        ...existing,
        [field]: typeof change.after === 'boolean' ? change.after : null,
        updatedAt: at,
      };
    }
    return { ...state, charts: { ...state.charts, [key]: updated } };
  }

  const tooth = state.teeth[change.tooth] ?? emptyTooth(change.tooth);
  if (change.field === 'missing') {
    return {
      ...state,
      teeth: {
        ...state.teeth,
        [change.tooth]: { ...tooth, missing: change.after === true, updatedAt: at },
      },
    };
  }
  const field = change.field === 'furcation' ? 'furcation' : 'mobility';
  return {
    ...state,
    teeth: {
      ...state.teeth,
      [change.tooth]: {
        ...tooth,
        [field]: typeof change.after === 'number' ? change.after : null,
        updatedAt: at,
      },
    },
  };
}

export function applyChanges(
  state: ChartState,
  changes: readonly ChartChange[],
  at: number,
): ChartState {
  return changes.reduce((current, change) => applyChange(current, change, at), state);
}

/** The inverse write, used to reverse an entry without deleting it. */
export function invertChanges(changes: readonly ChartChange[]): ChartChange[] {
  return [...changes]
    .reverse()
    .map((change) => ({ ...change, before: change.after, after: change.before }));
}

/** The newest entry a clinician could reverse. */
export function undoableEntry(journal: readonly JournalEntry[]): JournalEntry | null {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (!entry.undone && entry.compensates === null && entry.changes.length > 0) return entry;
  }
  return null;
}

/** The most recently reversed entry, which a redo would reinstate. */
export function redoableEntry(journal: readonly JournalEntry[]): JournalEntry | null {
  let newest: JournalEntry | null = null;
  let newestUndoId = -1;
  for (const entry of journal) {
    if (entry.compensates === null || entry.kind !== 'undo') continue;
    if (entry.id > newestUndoId) {
      const target = journal.find((candidate) => candidate.id === entry.compensates);
      if (target !== undefined && target.undone) {
        newest = target;
        newestUndoId = entry.id;
      }
    }
  }
  return newest;
}

export function markUndone(
  journal: readonly JournalEntry[],
  id: number,
  undone: boolean,
): JournalEntry[] {
  return journal.map((entry) => (entry.id === id ? { ...entry, undone } : entry));
}

export function markSuperseded(
  journal: readonly JournalEntry[],
  id: number,
  supersededBy: number,
): JournalEntry[] {
  return journal.map((entry) => (entry.id === id ? { ...entry, supersededBy } : entry));
}

/** Entries that wrote a measurement and have not been reversed, newest first. */
export function measurementEntries(journal: readonly JournalEntry[]): JournalEntry[] {
  return [...journal]
    .reverse()
    .filter(
      (entry) =>
        !entry.undone
        && entry.compensates === null
        && entry.changes.some((change) => MEASUREMENT_FIELDS.has(change.field)),
    );
}

export function describeChange(change: ChartChange): string {
  const location = change.surface === null
    ? `tooth ${change.tooth}`
    : `tooth ${change.tooth} ${change.surface}`;
  const site = change.siteIndex === null ? '' : ` site ${change.siteIndex + 1}`;
  return `${location}${site} ${change.field}: ${format(change.before)} → ${format(change.after)}`;
}

function format(value: number | boolean | null): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}
