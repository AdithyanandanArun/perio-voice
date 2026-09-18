import { describe, expect, it } from 'vitest';
import { createInitialSession, currentRecord, processUtterance } from '../src/domain/clinicalEngine';
import { recordAt } from '../src/domain/chart';
import type { UtteranceInput } from '../src/domain/types';

function input(transcript: string): UtteranceInput {
  return {
    transcript,
    words: [],
    timing: { startedAt: 0, observedAt: 30 },
    source: 'asr',
    utteranceId: 1,
    audioMs: 600,
    decodeMs: 120,
    observedVersion: null,
    speaker: null,
  };
}

describe('session defaults', () => {
  it('ships with continuous charting on, balanced relevance, and no speaker requirement', () => {
    const session = createInitialSession();
    expect(session.settings).toEqual({
      autoAdvance: true,
      relevanceMode: 'balanced',
      requireSpeaker: false,
    });
  });
});

describe('balanced relevance keeps chatter out', () => {
  it('never charts speech aimed at the patient', () => {
    const session = processUtterance(createInitialSession(), input('you might feel some pressure here'));
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
    expect(session.history[0].kind).toBe('ignored');
    expect(session.journal).toHaveLength(0);
  });

  it('never charts a request made to another person', () => {
    const session = processUtterance(createInitialSession(), input('can you pass me four instruments'));
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
    expect(session.history[0].kind).toBe('ignored');
    expect(session.journal).toHaveLength(0);
  });
});

describe('balanced relevance stops holding uncertain speech for confirmation', () => {
  // "probing depth maybe three" scores as `uncertain` (clinical vocabulary plus
  // the hedge "maybe"): enforce holds it, balanced lets it proceed to grammar,
  // negation, correction and the sequence guard, which is exactly the point of
  // the owner's "a bit of both" rule.
  const utterance = 'probing depth maybe three';

  it('enforce holds the same input for confirmation instead of charting it', () => {
    const session = processUtterance(
      createInitialSession({ relevanceMode: 'enforce' }),
      input(utterance),
    );
    expect(session.history[0].kind).toBe('confirmation');
    expect(session.pending).toHaveLength(1);
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
  });

  it('balanced charts it because relevance no longer blocks the pipeline', () => {
    const session = processUtterance(
      createInitialSession({ relevanceMode: 'balanced' }),
      input(utterance),
    );
    expect(session.pending).toHaveLength(0);
    expect(currentRecord(session).probingDepths).toEqual([3, null, null]);
  });

  it('still records the uncertain relevance label in the trace under balanced', () => {
    const session = processUtterance(
      createInitialSession({ relevanceMode: 'balanced' }),
      input(utterance),
    );
    const relevance = session.history[0].trace.find((entry) => entry.stage === 'relevance');
    expect(relevance).toMatchObject({ outcome: 'confirm' });
    expect(relevance?.detail).toContain('uncertain');
  });
});

describe('shadow relevance lets everything through, including non_chartable', () => {
  it('charts speech that both enforce and balanced would block', () => {
    // "depth maybe three four five" scores non_chartable (the hedge outweighs the
    // clinical anchor), so enforce and balanced both refuse it; shadow is the
    // observe-only mode that never blocks a commit at all.
    const utterance = 'depth maybe three four five';

    const enforced = processUtterance(createInitialSession({ relevanceMode: 'enforce' }), input(utterance));
    expect(currentRecord(enforced).probingDepths).toEqual([null, null, null]);

    const balanced = processUtterance(createInitialSession({ relevanceMode: 'balanced' }), input(utterance));
    expect(currentRecord(balanced).probingDepths).toEqual([null, null, null]);

    const shadowed = processUtterance(createInitialSession({ relevanceMode: 'shadow' }), input(utterance));
    expect(currentRecord(shadowed).probingDepths).toEqual([3, 4, 5]);
    const relevance = shadowed.history[0].trace.find((entry) => entry.stage === 'relevance');
    expect(relevance).toMatchObject({ outcome: 'block' });
  });
});

describe('continuous charting advances lazily', () => {
  it('leaves a finished station only when the next measurement arrives, by default', () => {
    let session = processUtterance(createInitialSession(), input('three four five'));
    // Station is complete but the cursor has not moved: a finding or correction
    // spoken next still belongs to the tooth just charted.
    expect(session.context.tooth).toBe(14);

    session = processUtterance(session, input('bleeding'));
    expect(recordAt(session.charts, 14, 'buccal')).toMatchObject({
      probingDepths: [3, 4, 5],
      bleeding: true,
    });
    expect(session.context.tooth).toBe(14);

    session = processUtterance(session, input('two three four'));
    expect(session.context.tooth).toBe(15);
    expect(recordAt(session.charts, 15, 'buccal').probingDepths).toEqual([2, 3, 4]);
  });
});
