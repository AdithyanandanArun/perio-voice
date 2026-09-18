import { describe, expect, it } from 'vitest';
import {
  applyTranscript,
  createInitialSession,
  currentRecord,
  latencySummary,
  updateContext,
} from '../src/domain/clinicalEngine';

const timing = (startedAt = 100, observedAt = 140) => ({ startedAt, observedAt });

// These cases were authored assuming a session starts at tooth 14 buccal;
// pin that explicitly since a new session now starts at tooth 1 buccal
// (the first station of the full-mouth sweep — see initialStation.test.ts).
function startSession() {
  return updateContext(createInitialSession(), { tooth: 14, surface: 'buccal' }, -1);
}

describe('clinicalEngine', () => {
  it('starts a new exam at tooth 1 buccal, the first station of the sweep', () => {
    const session = createInitialSession();
    expect(session.context).toMatchObject({
      tooth: 1,
      surface: 'buccal',
      measurement: 'probing_depth',
      expectedValues: 3,
      position: 0,
    });
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
  });

  it('records a grouped three-depth sequence in order', () => {
    const next = applyTranscript(createInitialSession(), 'three four five', timing());
    expect(currentRecord(next).probingDepths).toEqual([3, 4, 5]);
    expect(next.context.position).toBe(3);
    expect(next.history[0]).toMatchObject({ kind: 'depth_sequence', latencyMs: 40 });
  });

  it('accepts one depth at a time without losing sequence position', () => {
    let session = applyTranscript(createInitialSession(), 'three', timing());
    session = applyTranscript(session, 'four', timing(150, 180));
    session = applyTranscript(session, 'five', timing(190, 220));
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
    expect(session.context.position).toBe(3);
  });

  it('records positive and explicitly negated bleeding findings', () => {
    let session = applyTranscript(createInitialSession(), 'bleeding', timing());
    expect(currentRecord(session).bleeding).toBe(true);
    session = applyTranscript(session, 'no bleeding', timing(200, 245));
    expect(currentRecord(session).bleeding).toBe(false);
    expect(session.history[0].message).toContain('no');
  });

  it('corrects the last filled depth without advancing or shifting the sequence', () => {
    let session = applyTranscript(createInitialSession(), 'three four five', timing());
    session = applyTranscript(session, 'four no three', timing(200, 250));
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 3]);
    expect(session.context.position).toBe(3);
    expect(session.history[0]).toMatchObject({ kind: 'correction' });
  });

  it('replaces a full sequence after a natural repeat command', () => {
    let session = applyTranscript(createInitialSession(), 'three three four', timing());
    session = applyTranscript(session, 'repeat that three four four', timing(200, 280));
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 4]);
    expect(session.history[0].kind).toBe('sequence_replacement');
  });

  it('uses the final tooth in a spoken tooth correction', () => {
    const session = applyTranscript(
      createInitialSession(),
      'tooth fourteen sorry fifteen',
      timing(),
    );
    expect(session.context.tooth).toBe(15);
    expect(session.context.surface).toBe('buccal');
  });

  it('updates tooth and surface together from natural context speech', () => {
    const session = applyTranscript(createInitialSession(), 'tooth sixteen lingual', timing());
    expect(session.context).toMatchObject({ tooth: 16, surface: 'lingual', position: 0 });
  });

  it('preserves independent chart records while moving between contexts', () => {
    let session = applyTranscript(startSession(), 'three four five', timing());
    session = updateContext(session, { tooth: 15, surface: 'lingual' }, 200);
    session = applyTranscript(session, 'two three four', timing(220, 260));
    session = updateContext(session, { tooth: 14, surface: 'buccal' }, 300);
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
    expect(session.context.position).toBe(3);
  });

  it('rejects overflow atomically so later sites cannot shift', () => {
    let session = applyTranscript(createInitialSession(), 'three four', timing());
    session = applyTranscript(session, 'five six', timing(200, 230));
    expect(currentRecord(session).probingDepths).toEqual([3, 4, null]);
    expect(session.context.position).toBe(2);
    expect(session.history[0]).toMatchObject({ kind: 'rejected' });
  });

  it('rejects out-of-range probing depths without a partial write', () => {
    const session = applyTranscript(createInitialSession(), 'three thirteen five', timing());
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
    expect(session.history[0].message).toContain('1 and 12');
  });

  it('ignores conversational speech even when it includes a number', () => {
    const session = applyTranscript(
      createInitialSession(),
      'can you pass me four instruments',
      timing(),
    );
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
    expect(session.history[0]).toMatchObject({ kind: 'ignored' });
  });

  it('records numbers and bleeding from one clinical utterance', () => {
    const session = applyTranscript(createInitialSession(), 'three four five bleeding', timing());
    expect(currentRecord(session)).toMatchObject({
      probingDepths: [3, 4, 5],
      bleeding: true,
    });
  });

  it('records numbers with a negated bleeding finding in one utterance', () => {
    const session = applyTranscript(createInitialSession(), 'three four five no bleeding', timing());
    expect(currentRecord(session)).toMatchObject({
      probingDepths: [3, 4, 5],
      bleeding: false,
    });
  });

  it('resolves short ASR homophones as depths only inside a charting phrase', () => {
    const session = applyTranscript(createInitialSession(), 'to for ate', timing());
    expect(currentRecord(session).probingDepths).toEqual([2, 4, 8]);
  });

  it('computes latest, average, and nearest-rank p95 latency', () => {
    expect(latencySummary([])).toEqual({ latest: null, average: null, p95: null });
    expect(latencySummary([10, 20, 30, 40, 100])).toEqual({
      latest: 100,
      average: 40,
      p95: 100,
    });
  });
});
