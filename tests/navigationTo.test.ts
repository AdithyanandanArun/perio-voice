import { describe, expect, it } from 'vitest';
import { applyTranscript, createInitialSession } from '../src/domain/clinicalEngine';
import type { ClinicalSession } from '../src/domain/types';

const timing = { receivedAt: 1, finalAt: 1 } as never;

function say(text: string, session: ClinicalSession = createInitialSession()): ClinicalSession {
  return applyTranscript(session, text, timing);
}

function depths(session: ClinicalSession, tooth: number, surface: 'buccal' | 'lingual') {
  return session.charts[`${tooth}-${surface}`]?.probingDepths ?? [null, null, null];
}

describe('"to" in a navigation phrase is never a value', () => {
  it.each([
    ['go to tooth fifteen', 15],
    ['Go to tooth 15.', 15],
    ['move to tooth twelve', 12],
    ['jump to tooth 20', 20],
    ['take me to tooth nine', 9],
  ])('"%s" moves to tooth %i and charts nothing', (text, tooth) => {
    const session = say(text);
    expect(session.context.tooth).toBe(tooth);
    expect(depths(session, tooth, 'buccal')).toEqual([null, null, null]);
  });

  it('keeps the named surface and charts nothing', () => {
    const session = say('switch to tooth eight lingual');
    expect(session.context).toMatchObject({ tooth: 8, surface: 'lingual' });
    expect(depths(session, 8, 'lingual')).toEqual([null, null, null]);
  });

  it('charts the values that follow the navigation, and only those', () => {
    const session = say('go to tooth fifteen three four five');
    expect(depths(session, 15, 'buccal')).toEqual([3, 4, 5]);
  });

  it('still reads "to" as two inside a measurement sequence', () => {
    const session = say('three to four');
    expect(depths(session, 1, 'buccal')).toEqual([3, 2, 4]);
  });
});
