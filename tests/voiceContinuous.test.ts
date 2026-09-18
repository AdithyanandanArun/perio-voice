import { describe, expect, it } from 'vitest';
import { createInitialSession, currentRecord, processUtterance, updateContext } from '../src/domain/clinicalEngine';
import { recordAt } from '../src/domain/chart';
import type { SessionSettings, UtteranceInput } from '../src/domain/types';

// These two cases were authored assuming a session starts at tooth 14 buccal;
// pin that explicitly since a new session now starts at tooth 1 buccal.
function startSession(settings: Partial<SessionSettings> = {}) {
  return updateContext(createInitialSession(settings), { tooth: 14, surface: 'buccal' }, -1);
}

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

describe('voice control of continuous charting', () => {
  it('"pause" turns continuous charting off, and a value after a completed station no longer advances', () => {
    let session = startSession({ autoAdvance: true });
    expect(session.settings.autoAdvance).toBe(true);

    session = processUtterance(session, input('pause'));
    expect(session.settings.autoAdvance).toBe(false);

    // Complete the station, then speak a further value: with autoAdvance off,
    // the cursor stays put exactly as it does today.
    session = processUtterance(session, input('three four five'));
    expect(session.context.tooth).toBe(14);
    session = processUtterance(session, input('two three four'));
    expect(session.context.tooth).toBe(14);
  });

  it('"start" turns continuous charting back on, and the next measurement after a completed station advances lazily', () => {
    let session = startSession({ autoAdvance: false });

    session = processUtterance(session, input('start'));
    expect(session.settings.autoAdvance).toBe(true);

    session = processUtterance(session, input('three four five'));
    // Lazy: the cursor has not moved yet even though the station is complete.
    expect(session.context.tooth).toBe(14);

    session = processUtterance(session, input('two three four'));
    expect(session.context.tooth).toBe(15);
    expect(recordAt(session.charts, 15, 'buccal').probingDepths).toEqual([2, 3, 4]);
  });

  it('both "pause" and "start" appear in history with a full stage trace', () => {
    let session = createInitialSession({ autoAdvance: true });
    session = processUtterance(session, input('pause'));
    const pauseEvent = session.history[0];
    expect(pauseEvent.trace.length).toBeGreaterThan(0);
    expect(pauseEvent.trace.some((entry) => entry.stage === 'commit' && entry.outcome === 'pass')).toBe(true);
    expect(pauseEvent.message.toLowerCase()).toContain('off');

    session = processUtterance(session, input('start charting'));
    const startEvent = session.history[0];
    expect(startEvent.trace.length).toBeGreaterThan(0);
    expect(startEvent.trace.some((entry) => entry.stage === 'commit' && entry.outcome === 'pass')).toBe(true);
    expect(startEvent.message.toLowerCase()).toContain('on');
  });

  it('"start over" still means repeat, not the continuous-charting toggle', () => {
    let session = createInitialSession();
    session = processUtterance(session, input('three four five'));
    session = processUtterance(session, input('start over two two two'));
    expect(currentRecord(session).probingDepths).toEqual([2, 2, 2]);
    // The setting is untouched by "start over".
    expect(session.settings.autoAdvance).toBe(true);
  });

  it('"resume" still resumes a skipped station rather than toggling anything', () => {
    let session = createInitialSession();
    session = processUtterance(session, input('skip'));
    const afterSkip = session.context.tooth;
    session = processUtterance(session, input('tooth twenty lingual'));
    expect(session.context.tooth).toBe(20);
    const beforeAutoAdvance = session.settings.autoAdvance;
    session = processUtterance(session, input('resume'));
    // "resume" returned to the station left behind by the jump to tooth 20,
    // not to a continuous-charting toggle — the setting is untouched.
    expect(session.context.tooth).toBe(afterSkip);
    expect(session.settings.autoAdvance).toBe(beforeAutoAdvance);
  });

  it('"let\'s start with tooth three" sets context, and does not toggle continuous charting', () => {
    let session = createInitialSession({ autoAdvance: false });
    session = processUtterance(session, input("let's start with tooth three"));
    expect(session.settings.autoAdvance).toBe(false);
    expect(session.context.tooth).toBe(3);
  });

  it('"pause, three four five" toggles off without half-applying the values', () => {
    let session = createInitialSession({ autoAdvance: true });
    session = processUtterance(session, input('pause, three four five'));
    expect(session.settings.autoAdvance).toBe(false);
    expect(currentRecord(session).probingDepths).toEqual([null, null, null]);
  });

  it('pause and start never bump context.version', () => {
    let session = createInitialSession({ autoAdvance: true });
    const versionBefore = session.context.version;
    session = processUtterance(session, input('pause'));
    expect(session.context.version).toBe(versionBefore);
    session = processUtterance(session, input('start'));
    expect(session.context.version).toBe(versionBefore);
  });
});
