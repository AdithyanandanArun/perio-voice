import { describe, expect, it } from 'vitest';
import { processAutoChart } from '../src/domain/autoChart';
import { recordAt } from '../src/domain/chart';
import { createInitialSession, currentRecord, percentile } from '../src/domain/clinicalEngine';
import type { ClinicalSession, UtteranceInput } from '../src/domain/types';

function input(transcript: string, overrides: Partial<UtteranceInput> = {}): UtteranceInput {
  return {
    transcript,
    words: [],
    timing: { startedAt: 10, observedAt: 40 },
    source: 'asr',
    utteranceId: 1,
    audioMs: 900,
    decodeMs: 80,
    observedVersion: null,
    speaker: null,
    ...overrides,
  };
}

function expectNoClinicalMutation(before: ClinicalSession, after: ClinicalSession): void {
  expect(after.charts).toEqual(before.charts);
  expect(after.teeth).toEqual(before.teeth);
  expect(after.context).toEqual(before.context);
  expect(after.workflow).toEqual(before.workflow);
  expect(after.journal).toEqual(before.journal);
  expect(after.pending).toEqual(before.pending);
}

describe('automatic charting', () => {
  it('commits two fully specified stations as one all-or-nothing batch', () => {
    const started = createInitialSession();
    const result = processAutoChart(started, input(
      'tooth fourteen buccal depths three four five bleeding; tooth fifteen lingual depths two three four no bleeding',
    ));

    expect(result).toMatchObject({ mode: 'batch', decision: 'committed', clauses: 2, reason: null });
    expect(recordAt(result.session.charts, 14, 'buccal')).toMatchObject({
      probingDepths: [3, 4, 5],
      bleeding: true,
    });
    expect(recordAt(result.session.charts, 15, 'lingual')).toMatchObject({
      probingDepths: [2, 3, 4],
      bleeding: false,
    });
    expect(result.session.journal).toHaveLength(2);
    expect(result.session.history).toHaveLength(2);
  });

  it('keeps ordinary one-statement charting on the established pipeline', () => {
    const result = processAutoChart(createInitialSession(), input('three four five'));
    expect(result).toMatchObject({ mode: 'single', decision: 'committed', clauses: 1 });
    expect(currentRecord(result.session).probingDepths).toEqual([3, 4, 5]);
  });
});

describe('automatic chart safety', () => {
  it('does not inherit a station across a delimiter', () => {
    const before = createInitialSession();
    const result = processAutoChart(before, input('tooth fourteen buccal three four five; two three four'));

    expect(result.decision).toBe('rejected');
    expect(result.reason).toContain('clause 2');
    expectNoClinicalMutation(before, result.session);
    expect(result.session.history[0]).toMatchObject({ kind: 'rejected' });
    expect(result.session.history[0].trace).toEqual([
      expect.objectContaining({ stage: 'auto_chart', outcome: 'reject' }),
    ]);
  });

  it('rolls back an otherwise valid batch when a later directive is out of range', () => {
    const before = createInitialSession();
    const result = processAutoChart(before, input(
      'tooth fourteen buccal three four five; tooth fifteen lingual two thirteen four',
    ));

    expect(result.decision).toBe('rejected');
    expectNoClinicalMutation(before, result.session);
    expect(recordAt(result.session.charts, 14, 'buccal').probingDepths).toEqual([null, null, null]);
  });

  it('refuses conversational and partially parsed directives before any chart mutation', () => {
    const before = createInitialSession();
    const conversational = processAutoChart(before, input(
      'tooth fourteen buccal can you pass me three four five; tooth fifteen lingual two three four',
    ));
    expect(conversational.decision).toBe('rejected');
    expectNoClinicalMutation(before, conversational.session);

    const partial = processAutoChart(before, input(
      'tooth fourteen buccal three four five; tooth fifteen lingual two three four afterwards',
    ));
    expect(partial.decision).toBe('rejected');
    expectNoClinicalMutation(before, partial.session);
  });

  it('does not let an observation made against an old station create a batch', () => {
    const before = createInitialSession();
    const result = processAutoChart(before, input(
      'tooth fourteen buccal three four five; tooth fifteen lingual two three four',
      { observedVersion: 0 },
    ));
    expect(result.decision).toBe('rejected');
    expectNoClinicalMutation(before, result.session);
  });

  it('refuses context-resolved homophones in a batch rather than choosing for the clinician', () => {
    const before = createInitialSession();
    const result = processAutoChart(before, input(
      'tooth fourteen buccal to for ate; tooth fifteen lingual two three four',
    ));
    expect(result.decision).toBe('rejected');
    expect(result.reason).toContain('unambiguous directive');
    expectNoClinicalMutation(before, result.session);
  });
});

describe('automatic chart latency', () => {
  it('keeps p95 planning below five milliseconds without a model or network call', () => {
    const samples: number[] = [];
    for (let index = 0; index < 160; index += 1) {
      const started = performance.now();
      const result = processAutoChart(createInitialSession(), input(
        'tooth fourteen buccal three four five bleeding; tooth fifteen lingual two three four no bleeding',
      ));
      samples.push(performance.now() - started);
      expect(result.decision).toBe('committed');
    }
    const p95 = percentile(samples, 0.95);
    expect(p95).not.toBeNull();
    expect(p95 as number).toBeLessThan(5);
  });
});
