import { describe, expect, it } from 'vitest';
import { applyTranscript, createInitialSession } from '../src/domain/clinicalEngine';
import type { ClinicalSession } from '../src/domain/types';

const timing = { receivedAt: 1, finalAt: 1 } as never;
const say = (session: ClinicalSession, text: string) => applyTranscript(session, text, timing);
const bleeding = (session: ClinicalSession) => session.charts['1-buccal']?.bleeding ?? null;

/** "no no bleeding" cancels back to positive at low confidence, so it is held. */
function held(): ClinicalSession {
  const session = say(createInitialSession(), 'no no bleeding');
  expect(session.pending).toHaveLength(1);
  expect(bleeding(session)).toBeNull();
  return session;
}

describe('answering a held confirmation by voice', () => {
  it.each(['chart', 'Chart.', 'chart it', 'confirm'])('"%s" charts the held item', (answer) => {
    const session = say(held(), answer);
    expect(session.pending).toHaveLength(0);
    expect(bleeding(session)).toBe(true);
  });

  it.each(['deny', 'reject that', 'discard'])('"%s" discards it and charts nothing', (answer) => {
    const session = say(held(), answer);
    expect(session.pending).toHaveLength(0);
    expect(bleeding(session)).toBeNull();
  });

  it('does nothing when no confirmation is waiting', () => {
    const before = createInitialSession();
    const after = say(before, 'chart');
    expect(after.pending).toHaveLength(0);
    expect(after.charts).toEqual(before.charts);
  });

  it('never treats a clinical sentence containing "chart" as an approval', () => {
    const session = say(held(), 'chart tooth three buccal');
    expect(session.pending).toHaveLength(1);
    expect(bleeding(session)).toBeNull();
  });
});
