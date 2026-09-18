import { describe, expect, it } from 'vitest';
import { createInitialSession, currentRecord, processUtterance } from '../src/domain/clinicalEngine';
import { recordAt } from '../src/domain/chart';
import { percentile } from '../src/domain/session';
import type { ClinicalSession, SpeakerVerdict, StageName, UtteranceInput } from '../src/domain/types';

function input(transcript: string, overrides: Partial<UtteranceInput> = {}): UtteranceInput {
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
    ...overrides,
  };
}

function speaker(decision: SpeakerVerdict['decision'], overridden = false): SpeakerVerdict {
  return { decision, similarity: decision === 'clinician' ? 0.88 : 0.21, overridden };
}

function stages(session: ClinicalSession): StageName[] {
  return session.history[0].trace.map((entry) => entry.stage);
}

describe('pipeline stage order', () => {
  it('runs every stage in the declared order for a charted utterance', () => {
    const session = processUtterance(createInitialSession(), input('three four five'));
    expect(stages(session)).toEqual([
      'speaker',
      'staleness',
      'lexicon',
      'lattice',
      'relevance',
      'context',
      'grammar',
      'sequence',
      'commit',
    ]);
  });

  it('stops at the stage that refused, and says why', () => {
    const session = processUtterance(createInitialSession(), input('can you pass me four instruments'));
    expect(stages(session)).toEqual(['speaker', 'staleness', 'lexicon', 'lattice', 'relevance']);
    const relevance = session.history[0].trace.at(-1);
    expect(relevance).toMatchObject({ outcome: 'block' });
    expect(relevance?.detail).toContain('request to another person');
  });

  it('records what the lexicon and the resolver changed', () => {
    const session = processUtterance(createInitialSession(), input('p d to for ate'));
    const trace = session.history[0].trace;
    expect(trace.find((entry) => entry.stage === 'lexicon')?.detail).toContain('p d→depth');
    expect(trace.find((entry) => entry.stage === 'context')?.detail).toBe('to→2, for→4, ate→8');
    expect(currentRecord(session).probingDepths).toEqual([2, 4, 8]);
  });
});

describe('speaker attribution gate', () => {
  it('lets the clinician chart when attribution is required and verified', () => {
    const session = processUtterance(
      createInitialSession({ requireSpeaker: true }),
      input('three four five', { speaker: speaker('clinician') }),
    );
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
  });

  it('blocks another speaker before anything is parsed', () => {
    const session = processUtterance(
      createInitialSession({ requireSpeaker: true }),
      input('three four five', { speaker: speaker('other') }),
    );
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
    expect(session.counters.blockedSpeaker).toBe(1);
    expect(stages(session)).toEqual(['speaker']);
  });

  it('holds an unrecognized voice for confirmation instead of discarding it', () => {
    const session = processUtterance(
      createInitialSession({ requireSpeaker: true }),
      input('three four five', { speaker: speaker('unknown') }),
    );
    expect(session.pending[0]).toMatchObject({ reason: 'unknown_speaker' });
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
  });

  it('respects a manual attribution override', () => {
    const session = processUtterance(
      createInitialSession({ requireSpeaker: true }),
      input('three four five', { speaker: speaker('other', true) }),
    );
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
  });

  it('ignores attribution entirely when the session does not require it', () => {
    const session = processUtterance(
      createInitialSession(),
      input('three four five', { speaker: speaker('other') }),
    );
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
  });
});

describe('stale context guard', () => {
  it('refuses a final that was overtaken by a change of location', () => {
    const session = processUtterance(
      createInitialSession(),
      input('three four five', { observedVersion: 0 }),
    );
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
    expect(session.counters.staleContext).toBe(1);
    expect(session.history[0].message).toContain('clinical context changed');
  });

  it('accepts a final that observed the current location', () => {
    const session = processUtterance(
      createInitialSession(),
      input('three four five', { observedVersion: 1 }),
    );
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
  });
});

describe('relevance shadow mode', () => {
  it('records the decision without blocking the commit', () => {
    const session = processUtterance(
      createInitialSession({ relevanceMode: 'shadow' }),
      input('okay this looks fine three four five'),
    );
    expect(session.counters.nonChartable).toBe(1);
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
  });
});

describe('multi-intent utterances', () => {
  it('moves context, records depths, and asserts a finding in one pass', () => {
    const session = processUtterance(
      createInitialSession(),
      input('tooth fifteen three four five bleeding'),
    );
    expect(session.context.tooth).toBe(15);
    expect(recordAt(session.charts, 15, 'buccal')).toMatchObject({
      probingDepths: [3, 4, 5],
      bleeding: true,
    });
    expect(recordAt(session.charts, 14, 'buccal').probingDepths).toEqual([null, null, null]);
  });

  it('records both graded findings on the tooth, not the surface', () => {
    const session = processUtterance(createInitialSession(), input('mobility two furcation class one'));
    expect(session.teeth[14]).toMatchObject({ mobility: 2, furcation: 1 });
  });
});

describe('auto advance', () => {
  it('stays put when explicitly disabled, so a single station can be reviewed', () => {
    const session = processUtterance(
      createInitialSession({ autoAdvance: false }),
      input('three four five'),
    );
    expect(session.context.tooth).toBe(14);

    // Continuous charting is the default now, but a completed station is still
    // left behind only once, never eagerly on the same utterance that filled it.
    const defaultSession = processUtterance(createInitialSession(), input('three four five'));
    expect(defaultSession.context.tooth).toBe(14);
  });

  it('leaves a finished station only when the next values arrive', () => {
    let session = processUtterance(
      createInitialSession({ autoAdvance: true }),
      input('three four five'),
    );
    // The station is complete but the cursor has not moved yet, so a finding or
    // a correction spoken next still belongs to the tooth just charted.
    expect(session.context.tooth).toBe(14);

    session = processUtterance(session, input('bleeding'));
    expect(recordAt(session.charts, 14, 'buccal')).toMatchObject({
      probingDepths: [3, 4, 5],
      bleeding: true,
    });

    session = processUtterance(session, input('two three four'));
    expect(session.context.tooth).toBe(15);
    expect(recordAt(session.charts, 15, 'buccal').probingDepths).toEqual([2, 3, 4]);
  });
});

describe('parser latency budget', () => {
  it('keeps p95 parser time under the declared 10 ms', () => {
    let session = createInitialSession({ autoAdvance: true });
    const phrases = [
      'three four five',
      'bleeding',
      'tooth fifteen lingual',
      'to for ate',
      'can you pass me that',
      'no bleeding or suppuration',
      'repeat that three four four',
    ];
    for (let index = 0; index < 210; index += 1) {
      session = processUtterance(session, input(phrases[index % phrases.length]));
    }
    const p95 = percentile(session.parserSamples, 0.95);
    expect(p95).not.toBeNull();
    expect(p95 as number).toBeLessThan(10);
  });
});

describe('recognizer alternatives', () => {
  it('re-reads an utterance through alternatives when the best reading means nothing', () => {
    // The recognizer dropped the values and returned only the measurement word,
    // which names a measurement without giving one and so parses to nothing. A
    // lower-ranked reading kept them.
    const session = processUtterance(
      createInitialSession(),
      input('depth', {
        alternatives: [
          { text: 'depth', confidence: 62 },
          { text: 'depth three four five', confidence: 61 },
        ],
      }),
    );
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
    const grammar = session.history[0].trace.find((entry) => entry.stage === 'grammar');
    expect(grammar?.detail).toContain('re-read as "depth three four five"');
  });

  it('never overrides a reading that already carried clinical meaning', () => {
    const session = processUtterance(
      createInitialSession(),
      input('three four five', {
        alternatives: [
          { text: 'three four five', confidence: 80 },
          { text: 'two two two', confidence: 79 },
        ],
      }),
    );
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
  });

  it('leaves an utterance refused when no alternative carries meaning either', () => {
    const session = processUtterance(
      createInitialSession(),
      input('depth', { alternatives: [{ text: 'probing depth', confidence: 30 }] }),
    );
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
    expect(session.history[0].kind).toBe('ignored');
  });

  it('does not let an alternative resurrect speech that relevance refused', () => {
    // Conversation stops at relevance, before alternatives are ever consulted,
    // so a plausible-sounding alternative cannot smuggle a value into the chart.
    const session = processUtterance(
      createInitialSession(),
      input('can you pass me that', {
        alternatives: [
          { text: 'can you pass me that', confidence: 40 },
          { text: 'three four five', confidence: 39 },
        ],
      }),
    );
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
    expect(session.counters.nonChartable).toBe(1);
  });
});

describe('transcripts written by large recognizers', () => {
  it('reads letters and digits a recognizer fused into one token', () => {
    // Measured: "p d three four five" was written as "pd345".
    const session = processUtterance(createInitialSession(), input('pd345.'));
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 5]);
  });

  it('keeps a correction whose first value was heard as "or"', () => {
    // Measured: "four no three" was written as "or no three".
    let session = processUtterance(createInitialSession(), input('three four five.'));
    session = processUtterance(session, input('or no three.'));
    expect(currentRecord(session).probingDepths).toEqual([3, 4, 3]);
  });

  it('still negates across "or" between findings', () => {
    const session = processUtterance(createInitialSession(), input('no bleeding or suppuration.'));
    expect(currentRecord(session)).toMatchObject({ bleeding: false, suppuration: false });
  });
});
