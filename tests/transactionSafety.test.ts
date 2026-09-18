import { describe, expect, it } from 'vitest';
import {
  applyTranscript,
  createInitialSession,
  currentRecord,
  updateContext,
} from '../src/domain/clinicalEngine';
import { processAutoChart } from '../src/domain/autoChart';
import { recordAt } from '../src/domain/chart';
import { resolveConfirmation, processUtterance } from '../src/domain/pipeline';
import { transactionIdentityForInput } from '../src/domain/session';
import type { ClinicalSession, SpeakerVerdict, UtteranceInput } from '../src/domain/types';

function input(transcript: string, overrides: Partial<UtteranceInput> = {}): UtteranceInput {
  return {
    transcript,
    words: [],
    timing: { startedAt: 0, observedAt: 30 },
    source: 'asr',
    utteranceId: null,
    audioMs: 600,
    decodeMs: 120,
    observedVersion: 1,
    speaker: null,
    ...overrides,
  };
}

function unknownSpeaker(): SpeakerVerdict {
  return { decision: 'unknown', similarity: 0.42, overridden: false };
}

function chartAndJournal(session: ClinicalSession): { charts: ClinicalSession['charts']; journal: ClinicalSession['journal'] } {
  return { charts: session.charts, journal: session.journal };
}

function say(session: ClinicalSession, transcript: string, at = 0): ClinicalSession {
  return applyTranscript(session, transcript, { startedAt: at, observedAt: at + 30 });
}

describe('transaction identity and bounded idempotency', () => {
  it('attaches stable identity and confirmed lifecycle to durable writes', () => {
    const base = input('three four five', {
      streamId: 'stream-a',
      transactionId: 'tx-a',
      utteranceId: 7,
      revision: 2,
    });
    const identity = transactionIdentityForInput(base, 1);
    expect(identity).toMatchObject({
      transactionId: 'tx-a',
      streamId: 'stream-a',
      utteranceId: 7,
      revision: 2,
      observedVersion: 1,
      originalContextVersion: 1,
    });

    const session = processUtterance(createInitialSession(), base);
    expect(session.history[0]).toMatchObject({
      lifecycle: 'confirmed',
      decision: 'committed',
      transaction: identity,
    });
    expect(session.journal[0]).toMatchObject({ transactionId: 'tx-a', lifecycle: 'confirmed' });
  });

  it('makes an identical final a no-op after the prior decision', () => {
    const base = input('three four five', {
      streamId: 'stream-a', transactionId: 'tx-a', utteranceId: 7,
    });
    const first = processUtterance(createInitialSession(), base);
    const duplicate = processUtterance(first, {
      ...base,
      timing: { startedAt: 500, observedAt: 900 },
      audioMs: 1_200,
      decodeMs: 240,
    });
    expect(duplicate).toBe(first);
    expect(duplicate.journal).toHaveLength(1);
    expect(duplicate.history).toHaveLength(1);
  });

  it('anchors identity to the observed version when the transaction moves context', () => {
    const base = input('tooth fifteen three four five', {
      streamId: 'stream-a', transactionId: 'tx-context', utteranceId: 8,
    });
    const first = processUtterance(createInitialSession(), base);
    expect(recordAt(first.charts, 15, 'buccal').probingDepths).toEqual([3, 4, 5]);
    expect(processUtterance(first, base)).toBe(first);
  });

  it('keeps one batch identity idempotent across all shadow clauses', () => {
    const base = input('tooth fourteen buccal depths three four five; tooth fifteen lingual depths two three four', {
      streamId: 'stream-a', transactionId: 'tx-batch', utteranceId: 9,
    });
    const first = processAutoChart(createInitialSession(), base).session;
    const duplicate = processAutoChart(first, base);
    expect(duplicate.session).toBe(first);
    expect(first.journal.every((entry) => entry.transactionId === 'tx-batch')).toBe(true);
    expect(first.history.slice(0, 2).every((event) => event.transactionId === 'tx-batch')).toBe(true);
  });

  it('rejects a conflicting payload without chart or journal mutation', () => {
    const first = processUtterance(createInitialSession(), input('three four five', {
      streamId: 'stream-a', transactionId: 'tx-a', utteranceId: 7,
    }));
    const before = chartAndJournal(first);
    const conflict = processUtterance(first, input('three four six', {
      streamId: 'stream-a', transactionId: 'tx-a', utteranceId: 7,
    }));
    expect(conflict.charts).toEqual(before.charts);
    expect(conflict.journal).toEqual(before.journal);
    expect(conflict.history[0]).toMatchObject({ kind: 'rejected', decision: 'rejected' });
    expect(conflict.history).toHaveLength(2);
  });

  it('keeps the idempotency registry bounded', () => {
    let session = createInitialSession();
    for (let index = 0; index < 320; index += 1) {
      session = processUtterance(session, input('bleeding', {
        streamId: 'stream-a', transactionId: `tx-${index}`, utteranceId: index,
      }));
    }
    expect(Object.keys(session.transactions).length).toBeLessThanOrEqual(256);
    expect(session.transactionOrder.length).toBeLessThanOrEqual(256);
  });

  it('keeps provisional revisions projection-only, then journals one terminal revision', () => {
    const provisional = processUtterance(
      createInitialSession(),
      input('three four five', {
        streamId: 'stream-revision',
        transactionId: 'tx-revision',
        utteranceId: 10,
        revision: 1,
        lifecycle: 'provisional',
      }),
    );
    expect(currentRecord(provisional).probingDepths).toEqual([null, null, null]);
    expect(provisional.journal).toEqual([]);
    expect(provisional.history[0]).toMatchObject({
      lifecycle: 'provisional',
      decision: 'held',
      projectionAction: 'replace',
    });
    expect(provisional.history[0].projection).toMatchObject({
      transaction: { transactionId: 'tx-revision', revision: 1 },
      changes: [
        { field: 'probingDepths', siteIndex: 0, before: null, after: 3 },
        { field: 'probingDepths', siteIndex: 1, before: null, after: 4 },
        { field: 'probingDepths', siteIndex: 2, before: null, after: 5 },
      ],
      context: { tooth: 14, surface: 'buccal', position: 3 },
    });
    expect(provisional.history[0].projection?.workflow).toEqual(provisional.workflow);
    expect(provisional.transactions['tx-revision']).toMatchObject({
      identity: { transactionId: 'tx-revision', revision: 1 },
      lifecycle: 'provisional',
      decision: 'held',
    });

    const terminalInput = input('three four five', {
      streamId: 'stream-revision',
      transactionId: 'tx-revision',
      utteranceId: 10,
      revision: 2,
      lifecycle: 'confirmed',
    });
    const terminal = processUtterance(provisional, terminalInput);
    expect(currentRecord(terminal).probingDepths).toEqual([3, 4, 5]);
    expect(terminal.journal).toHaveLength(1);
    expect(terminal.history[0]).toMatchObject({ projection: null, projectionAction: 'confirm' });
    expect(terminal.transactions['tx-revision']).toMatchObject({
      identity: { transactionId: 'tx-revision', revision: 2 },
      lifecycle: 'confirmed',
      decision: 'committed',
    });

    const duplicate = processUtterance(terminal, {
      ...terminalInput,
      revision: 2,
      timing: { startedAt: 900, observedAt: 1_000 },
    });
    expect(duplicate).toBe(terminal);
    const lowerRevision = processUtterance(terminal, { ...terminalInput, revision: 1 });
    expect(lowerRevision).toBe(terminal);
    expect(terminal.journal).toHaveLength(1);
  });

  it('clears a provisional overlay when a later revision is rejected', () => {
    const provisional = processUtterance(
      createInitialSession(),
      input('three four five', {
        streamId: 'stream-rejected-projection',
        transactionId: 'tx-rejected-projection',
        utteranceId: 16,
        revision: 1,
        lifecycle: 'provisional',
      }),
    );
    const rejected = processUtterance(
      provisional,
      input('three thirteen five', {
        streamId: 'stream-rejected-projection',
        transactionId: 'tx-rejected-projection',
        utteranceId: 16,
        revision: 2,
      }),
    );
    expect(rejected.history[0]).toMatchObject({
      kind: 'rejected',
      projection: null,
      projectionAction: 'clear',
    });
    expect(currentRecord(rejected).probingDepths).toEqual([null, null, null]);
    expect(rejected.journal).toEqual([]);
  });

  it('replaces a held revision without leaving duplicate pending or journal writes', () => {
    const held = processUtterance(
      createInitialSession({ requireSpeaker: true }),
      input('three four five', {
        streamId: 'stream-held-revision',
        transactionId: 'tx-held-revision',
        utteranceId: 11,
        revision: 1,
        speaker: unknownSpeaker(),
      }),
    );
    expect(held.pending).toHaveLength(1);
    expect(held.journal).toEqual([]);
    expect(held.transactions['tx-held-revision']).toMatchObject({
      identity: { revision: 1 },
      lifecycle: 'held',
    });

    const terminal = processUtterance(
      held,
      input('three four five', {
        streamId: 'stream-held-revision',
        transactionId: 'tx-held-revision',
        utteranceId: 11,
        revision: 2,
        speaker: null,
      }),
    );
    expect(terminal.pending).toEqual([]);
    expect(currentRecord(terminal).probingDepths).toEqual([3, 4, 5]);
    expect(terminal.journal).toHaveLength(1);
    expect(terminal.history.filter((event) => event.journalEntryId !== null)).toHaveLength(1);
    expect(terminal.transactions['tx-held-revision']).toMatchObject({
      identity: { revision: 2 },
      lifecycle: 'confirmed',
      decision: 'committed',
    });
    expect(processUtterance(terminal, {
      ...input('three four five', {
        streamId: 'stream-held-revision',
        transactionId: 'tx-held-revision',
        utteranceId: 11,
        revision: 2,
        speaker: null,
      }),
      timing: { startedAt: 2_000, observedAt: 2_100 },
    })).toBe(terminal);
  });
});

describe('exact context versions and approval replay', () => {
  it.each([0, 2])('rejects an observed version %s away from the current context', (observedVersion) => {
    const before = createInitialSession();
    const session = processUtterance(before, input('three four five', { observedVersion }));
    expect(session.charts).toEqual(before.charts);
    expect(session.journal).toEqual([]);
    expect(session.history[0].kind).toBe('rejected');
    expect(session.history[0].trace.map((entry) => entry.stage)).toEqual(['speaker', 'staleness']);
  });

  it('revalidates the original context before approving a held transaction', () => {
    let session = processUtterance(
      createInitialSession({ requireSpeaker: true }),
      input('three four five', {
        streamId: 'stream-a', transactionId: 'held-a', utteranceId: 3,
        speaker: unknownSpeaker(),
      }),
    );
    expect(session.pending).toHaveLength(1);
    expect(session.history[0]).toMatchObject({ lifecycle: 'held', decision: 'held' });
    const pendingId = session.pending[0].id;
    session = updateContext(session, { tooth: 20 }, 100);

    const approved = resolveConfirmation(session, pendingId, true, 200);
    expect(recordAt(approved.charts, 14, 'buccal').probingDepths).toEqual([null, null, null]);
    expect(approved.journal).toEqual([]);
    expect(approved.pending).toEqual([]);
    expect(approved.history[0]).toMatchObject({ kind: 'rejected', decision: 'rejected' });
  });

  it('replays the same held transaction when the original context is intact', () => {
    let session = processUtterance(
      createInitialSession({ requireSpeaker: true }),
      input('three four five', {
        streamId: 'stream-a', transactionId: 'held-b', utteranceId: 4,
        speaker: unknownSpeaker(),
      }),
    );
    const pendingId = session.pending[0].id;
    session = resolveConfirmation(session, pendingId, true, 200);
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
    expect(session.journal).toHaveLength(1);
    expect(session.history[0]).toMatchObject({ lifecycle: 'confirmed', decision: 'committed' });
  });

  it('fails closed for transaction-bearing ASR without an observed context version', () => {
    const before = createInitialSession();
    const rejected = processUtterance(before, input('three four five', {
      streamId: 'stream-missing-context',
      transactionId: 'tx-missing-context',
      utteranceId: 12,
      observedVersion: null,
      originalContextVersion: null,
    }));
    expect(rejected.charts).toEqual(before.charts);
    expect(rejected.journal).toEqual([]);
    expect(rejected.pending).toEqual([]);
    expect(rejected.transactions).toEqual({});
    expect(rejected.history[0]).toMatchObject({ kind: 'rejected', decision: 'rejected' });
    expect(rejected.history[0].message).toMatch(/context version/i);

    const simulator = processUtterance(createInitialSession(), input('three four five', {
      source: 'simulator',
      streamId: 'stream-legacy-simulator',
      transactionId: 'tx-legacy-simulator',
      utteranceId: 13,
      observedVersion: null,
      originalContextVersion: null,
    }));
    expect(currentRecord(simulator).probingDepths).toEqual([3, 4, 5]);

    const evaluation = processUtterance(createInitialSession(), input('three four five', {
      source: 'evaluation',
      streamId: 'stream-legacy-evaluation',
      transactionId: 'tx-legacy-evaluation',
      utteranceId: 14,
      observedVersion: null,
      originalContextVersion: null,
    }));
    expect(currentRecord(evaluation).probingDepths).toEqual([3, 4, 5]);
  });

  it('fails closed for delimited ASR batches without binding them to the live cursor', () => {
    const before = createInitialSession();
    const result = processAutoChart(before, input('tooth fourteen buccal depths three four five; tooth fifteen lingual depths two three four', {
      streamId: 'stream-batch-missing-context',
      transactionId: 'tx-batch-missing-context',
      utteranceId: 15,
      observedVersion: null,
      originalContextVersion: null,
    }));
    expect(result.decision).toBe('rejected');
    expect(result.session.charts).toEqual(before.charts);
    expect(result.session.journal).toEqual([]);
    expect(result.session.transactions).toEqual({});
  });
});

describe('graded findings never invent a grade', () => {
  it.each(['mobility', 'furcation'])('holds a positive %s finding without an explicit grade for repeat', (finding) => {
    const before = createInitialSession();
    const session = processUtterance(before, input(finding));
    expect(session.teeth).toEqual(before.teeth);
    expect(session.journal).toEqual([]);
    expect(session.history[0]).toMatchObject({ kind: 'confirmation', decision: 'held', lifecycle: 'held' });
    expect(session.history[0].message).toMatch(/explicit grade/i);
    expect(session.pending).toHaveLength(1);
    expect(session.pending[0]).toMatchObject({
      reason: 'missing_grade',
      approvable: false,
      repeatRequired: true,
    });

    const approved = resolveConfirmation(session, session.pending[0].id, true, 200);
    expect(approved.teeth).toEqual(before.teeth);
    expect(approved.journal).toEqual([]);
    expect(approved.pending).toEqual([]);
    expect(approved.history[0]).toMatchObject({ kind: 'ignored', decision: 'ignored', lifecycle: 'held' });
    expect(approved.history[0].message).toMatch(/repeat|required/i);
  });
});

describe('shadow-state atomicity and measurement shape', () => {
  it('rolls back context and earlier values when a later intent is rejected', () => {
    const before = createInitialSession();
    const session = processUtterance(before, input('tooth fifteen three thirteen five bleeding'));
    expect(session.context).toEqual(before.context);
    expect(session.workflow).toEqual(before.workflow);
    expect(session.charts).toEqual(before.charts);
    expect(session.journal).toEqual([]);
    expect(session.history[0].kind).toBe('rejected');
  });

  it('accepts only the 1/2/3 values that fit the remaining open sites', () => {
    let session = say(createInitialSession(), 'three');
    session = say(session, 'four five', 100);
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);

    const before = currentRecord(session).probingDepths;
    session = say(session, 'repeat that six seven', 200);
    expect(currentRecord(session).probingDepths).toEqual(before);
    expect(session.history[0].kind).toBe('rejected');
  });

  it('keeps a full replacement exactly three values with no placeholders', () => {
    let session = say(createInitialSession(), 'three four five');
    session = say(session, 'repeat that six seven', 100);
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
    session = say(session, 'repeat that six seven eight', 200);
    expect(currentRecord(session).probingDepths).toEqual([6, 7, 8]);
    expect(currentRecord(session).probingDepths).not.toContain(undefined);
  });
});
