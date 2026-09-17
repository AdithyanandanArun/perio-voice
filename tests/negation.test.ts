import { describe, expect, it } from 'vitest';
import { buildLattice } from '../src/domain/lattice';
import { canonicalize } from '../src/domain/lexicon';
import { resolveWithContext } from '../src/domain/contextResolver';
import {
  describeAssertion,
  needsPolarityConfirmation,
  resolveAssertions,
} from '../src/domain/negation';
import type { ClinicalContext } from '../src/domain/types';

const context: ClinicalContext = {
  tooth: 14,
  surface: 'buccal',
  measurement: 'probing_depth',
  expectedValues: 3,
  position: 0,
  version: 1,
};

function assertionsFor(phrase: string) {
  const { tokens } = canonicalize(phrase, { contextual: true });
  const resolved = resolveWithContext(buildLattice(tokens), context);
  return resolveAssertions(resolved.tokens).assertions;
}

function polarity(phrase: string) {
  return assertionsFor(phrase).map((assertion) => `${assertion.finding}:${assertion.polarity}`);
}

describe('negation scope', () => {
  it('asserts a bare finding as present', () => {
    const [assertion] = assertionsFor('bleeding');
    expect(assertion).toMatchObject({ finding: 'bleeding', polarity: 'positive', cue: null });
    expect(needsPolarityConfirmation(assertion)).toBe(false);
  });

  it('reverses a finding for every spoken negation cue', () => {
    for (const phrase of [
      'no bleeding',
      'not bleeding',
      'without bleeding',
      'negative for bleeding',
      'free of bleeding',
      'no evidence of bleeding',
    ]) {
      expect(polarity(phrase), phrase).toEqual(['bleeding:negative']);
    }
  });

  it('records the cue and the span it governed', () => {
    const [assertion] = assertionsFor('no bleeding');
    expect(assertion).toMatchObject({ cue: 'no', cueIndex: 0, scopeStart: 0, scopeEnd: 1 });
  });

  it('carries a negation across a conjunction', () => {
    expect(polarity('no bleeding or suppuration')).toEqual([
      'bleeding:negative',
      'suppuration:negative',
    ]);
  });

  it('asks about the weaker English of "and" after a cue instead of guessing', () => {
    const assertions = assertionsFor('no bleeding and calculus');
    expect(assertions.map((assertion) => assertion.polarity)).toEqual(['negative', 'negative']);
    expect(needsPolarityConfirmation(assertions[0])).toBe(false);
    expect(needsPolarityConfirmation(assertions[1])).toBe(true);
  });

  it('reaches across a modifier the recognizer kept', () => {
    const [assertion] = assertionsFor('no significant bleeding');
    expect(assertion.polarity).toBe('negative');
    expect(assertion.confidence).toBeLessThan(0.95);
  });

  it('closes the scope at a clause break so a later finding stays positive', () => {
    expect(polarity('no bleeding but calculus')).toEqual([
      'bleeding:negative',
      'calculus:positive',
    ]);
  });

  it('closes the scope at a measurement', () => {
    expect(polarity('no bleeding three four five')).toEqual(['bleeding:negative']);
    expect(polarity('three four five no bleeding')).toEqual(['bleeding:negative']);
  });

  it('treats a cue before a number as a self-correction, not a negation', () => {
    expect(assertionsFor('four no three')).toEqual([]);
    expect(assertionsFor('tooth fourteen no fifteen')).toEqual([]);
  });

  it('reverses a trailing cue onto the finding it follows, and asks about it', () => {
    const [assertion] = assertionsFor('bleeding no');
    expect(assertion.polarity).toBe('negative');
    expect(needsPolarityConfirmation(assertion)).toBe(true);
  });

  it('cancels a doubled cue back to present, and asks about it', () => {
    const [assertion] = assertionsFor('no no bleeding');
    expect(assertion.polarity).toBe('positive');
    expect(needsPolarityConfirmation(assertion)).toBe(true);
  });

  it('leaves independent findings in one utterance alone', () => {
    expect(polarity('plaque and calculus')).toEqual(['plaque:positive', 'calculus:positive']);
  });

  it('binds an ordinal grade in either spoken order', () => {
    expect(assertionsFor('mobility two')[0]).toMatchObject({ finding: 'mobility', grade: 2 });
    expect(assertionsFor('mobility grade two')[0]).toMatchObject({ grade: 2 });
    expect(assertionsFor('grade two mobility')[0]).toMatchObject({ grade: 2 });
    expect(assertionsFor('furcation class three')[0]).toMatchObject({ finding: 'furcation', grade: 3 });
  });

  it('does not treat a preceding measurement as a grade', () => {
    const [assertion] = assertionsFor('three mobility');
    expect(assertion).toMatchObject({ finding: 'mobility', grade: null });
  });

  it('grades a negated finding as zero', () => {
    expect(assertionsFor('no mobility')[0]).toMatchObject({ polarity: 'negative', grade: 0 });
  });

  it('marks the tokens a finding consumed so the grammar cannot reuse them', () => {
    const { tokens } = canonicalize('mobility two', { contextual: true });
    const resolved = resolveWithContext(buildLattice(tokens), context);
    expect([...resolveAssertions(resolved.tokens).consumed].sort()).toEqual([0, 1]);
  });

  it('describes an assertion for the audit trail', () => {
    expect(describeAssertion(assertionsFor('no bleeding')[0])).toBe('bleeding absent');
    expect(describeAssertion(assertionsFor('mobility two')[0])).toBe('mobility grade 2');
  });
});
