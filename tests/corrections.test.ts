import { describe, expect, it } from 'vitest';
import {
  applyTranscript,
  createInitialSession,
  currentRecord,
  updateContext,
} from '../src/domain/clinicalEngine';
import { recordAt } from '../src/domain/chart';
import { measurementEntries, redoableEntry, undoableEntry } from '../src/domain/journal';
import type { ClinicalSession } from '../src/domain/types';

let clock = 0;
function say(session: ClinicalSession, transcript: string): ClinicalSession {
  clock += 100;
  return applyTranscript(session, transcript, { startedAt: clock, observedAt: clock + 25 });
}

function fresh(): ClinicalSession {
  clock = 0;
  // These cases were authored assuming a session starts at tooth 14 buccal;
  // pin that explicitly now that a new exam starts at tooth 1 buccal instead.
  return updateContext(createInitialSession(), { tooth: 14, surface: 'buccal' }, -1);
}

describe('immediate self-correction', () => {
  it('replaces the last value in place instead of adding a fourth', () => {
    let session = say(fresh(), 'three four five');
    session = say(session, 'four no three');
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 3]);
    expect(session.context.position).toBe(3);
    expect(session.history[0].kind).toBe('correction');
  });

  it('accepts every spoken correction phrasing', () => {
    for (const phrase of ['four no three', 'correct that to three', 'i meant three', 'actually three']) {
      let session = say(fresh(), 'three four five');
      session = say(session, phrase);
      expect(currentRecord(session).probingDepths, phrase).toEqual([3, 4, 3]);
    }
  });

  it('corrects a partly filled station without advancing the cursor', () => {
    let session = say(fresh(), 'three four');
    session = say(session, 'no five');
    expect(currentRecord(session).probingDepths).toEqual([3, 5, null]);
    expect(session.context.position).toBe(2);
  });

  it('replaces the whole sequence when the clinician repeats it', () => {
    let session = say(fresh(), 'three three four');
    session = say(session, 'repeat that three four four');
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 4]);
    expect(session.history[0].kind).toBe('sequence_replacement');
  });

  it('refuses a correction that has nothing to correct', () => {
    const session = say(fresh(), 'no three');
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
    expect(session.history[0]).toMatchObject({ kind: 'rejected' });
  });

  it('refuses an out-of-range correction without touching the chart', () => {
    let session = say(fresh(), 'three four five');
    session = say(session, 'no thirteen');
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
    expect(session.history[0].message).toContain('1 and 12');
  });
});

describe('targeted site entry', () => {
  it('writes a named site directly', () => {
    const session = say(fresh(), 'distal buccal five');
    expect(currentRecord(session).probingDepths).toEqual([null, null, 5]);
  });

  it('asks before overwriting a named site that already holds a value', () => {
    let session = say(fresh(), 'three four five');
    session = say(session, 'mesial buccal six');
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
    expect(session.history[0].kind).toBe('confirmation');
  });
});

describe('delayed correction across a station boundary', () => {
  it('holds a correction that reaches back to an earlier tooth for confirmation', () => {
    let session = say(fresh(), 'three four five');
    session = updateContext(session, { tooth: 20 }, (clock += 50));
    session = say(session, 'no six');

    expect(session.history[0].kind).toBe('confirmation');
    expect(session.pending).toHaveLength(1);
    expect(session.pending[0]).toMatchObject({ reason: 'ambiguous_correction' });
    expect(session.pending[0].message).toContain('tooth 14');
    // Nothing was written anywhere while the question is open.
    expect(recordAt(session.charts, 14, 'buccal').probingDepths).toEqual([3, 4, 5]);
    expect(recordAt(session.charts, 20, 'buccal').probingDepths).toEqual([null, null, null]);
  });
});

describe('append-only journal', () => {
  it('records the previous value of every write', () => {
    let session = say(fresh(), 'three four five');
    session = say(session, 'four no three');
    const entries = session.journal;
    expect(entries).toHaveLength(2);
    expect(entries[0].changes).toHaveLength(3);
    expect(entries[1].changes[0]).toMatchObject({ siteIndex: 2, before: 5, after: 3 });
  });

  it('supersedes the corrected entry instead of editing it', () => {
    let session = say(fresh(), 'three four five');
    const originalId = session.journal[0].id;
    session = say(session, 'four no three');
    const original = session.journal.find((entry) => entry.id === originalId);
    expect(original?.changes[2]).toMatchObject({ after: 5 });
    expect(original?.supersededBy).toBe(session.journal[1].id);
  });

  it('exposes the newest reversible write', () => {
    const session = say(fresh(), 'three four five');
    expect(undoableEntry(session.journal)?.transcript).toBe('three four five');
    expect(measurementEntries(session.journal)).toHaveLength(1);
  });
});

describe('undo and redo', () => {
  it('reverses the last write and restores the cursor', () => {
    let session = say(fresh(), 'three four five');
    session = say(session, 'undo that');
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
    expect(session.context.position).toBe(0);
    expect(session.history[0].kind).toBe('undo');
  });

  it('reinstates a reversed write', () => {
    let session = say(fresh(), 'three four five');
    session = say(session, 'undo that');
    expect(redoableEntry(session.journal)?.transcript).toBe('three four five');
    session = say(session, 'redo');
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
    expect(session.history[0].kind).toBe('redo');
  });

  it('walks back through several writes in order', () => {
    let session = say(fresh(), 'three');
    session = say(session, 'four');
    session = say(session, 'five');
    session = say(session, 'undo that');
    expect(currentRecord(session).probingDepths).toEqual([3, 4, null]);
    session = say(session, 'undo that');
    expect(currentRecord(session).probingDepths).toEqual([3, null, null]);
  });

  it('keeps reversals in history rather than deleting the original entries', () => {
    let session = say(fresh(), 'three four five');
    session = say(session, 'undo that');
    expect(session.journal).toHaveLength(2);
    expect(session.journal[0].undone).toBe(true);
    expect(session.journal[1].compensates).toBe(session.journal[0].id);
  });

  it('reports that there is nothing to undo rather than doing nothing silently', () => {
    const session = say(fresh(), 'undo that');
    expect(session.history[0]).toMatchObject({ kind: 'rejected' });
    expect(session.history[0].message).toMatch(/nothing to undo/i);
  });
});
