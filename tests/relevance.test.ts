import { describe, expect, it } from 'vitest';
import { buildLattice } from '../src/domain/lattice';
import { canonicalize } from '../src/domain/lexicon';
import { classifyRelevance, explainRelevance, isMeasurementPhrase } from '../src/domain/relevance';
import type { ClinicalContext } from '../src/domain/types';

function context(overrides: Partial<ClinicalContext> = {}): ClinicalContext {
  return {
    tooth: 14,
    surface: 'buccal',
    measurement: 'probing_depth',
    expectedValues: 3,
    position: 0,
    version: 1,
    ...overrides,
  };
}

function classify(phrase: string, overrides: Partial<ClinicalContext> = {}) {
  const nodes = buildLattice(canonicalize(phrase).tokens);
  return classifyRelevance(nodes, context(overrides), {
    acoustic: null,
    audioMs: null,
    source: 'simulator',
  });
}

const CHARTABLE = [
  'three four five',
  'depths three four five',
  'three',
  'to for ate',
  'bleeding',
  'no bleeding',
  'four no three',
  'repeat that three four four',
  'tooth fifteen',
  'tooth sixteen lingual',
  'mobility two',
  'gingival recession two',
  'buccal',
  'suppuration',
];

const NON_CHARTABLE = [
  'okay this looks fine',
  'can you pass me that',
  "we'll take another look at this later",
  'you might feel some pressure here',
  'how are you doing today',
  'can you pass me four instruments',
  "let's get the suction in there",
  'thanks that was great',
  'it hurts around number four',
  'I need the mirror please',
  'we can schedule the next appointment',
];

describe('relevance classifier', () => {
  it('admits clinical speech in every supported phrasing', () => {
    for (const phrase of CHARTABLE) {
      expect(classify(phrase).label, phrase).toBe('chartable');
    }
  });

  it('keeps conversation, requests, and patient-directed speech out of the chart', () => {
    for (const phrase of NON_CHARTABLE) {
      expect(classify(phrase).label, phrase).toBe('non_chartable');
    }
  });

  it('measures a false chart entry rate of zero across the conversational set', () => {
    const admitted = NON_CHARTABLE.filter((phrase) => classify(phrase).label === 'chartable');
    expect(admitted).toEqual([]);
  });

  it('holds borderline speech for confirmation instead of guessing', () => {
    const decision = classify('bleeding maybe');
    expect(decision.label).toBe('uncertain');
    expect(decision.score).toBeGreaterThan(-0.15);
    expect(decision.score).toBeLessThan(0.35);
  });

  it('recognizes a bare number sequence but not a number inside ordinary speech', () => {
    expect(isMeasurementPhrase(buildLattice(canonicalize('three four five').tokens))).toBe(true);
    expect(isMeasurementPhrase(buildLattice(canonicalize('to for ate').tokens))).toBe(true);
    expect(isMeasurementPhrase(buildLattice(canonicalize('pass me four').tokens))).toBe(false);
    expect(isMeasurementPhrase(buildLattice(canonicalize('bleeding').tokens))).toBe(false);
  });

  it('rewards a value count that matches the open sites', () => {
    const full = classify('three four five');
    expect(full.reasons.map((reason) => reason.code)).toContain('expected_count');
    const partial = classify('three four five', { position: 1 });
    expect(partial.reasons.map((reason) => reason.code)).not.toContain('expected_count');
    expect(partial.label).toBe('chartable');
  });

  it('penalizes low recognizer confidence', () => {
    const nodes = buildLattice(canonicalize('bleeding').tokens);
    const confident = classifyRelevance(nodes, context(), { acoustic: 0.9, audioMs: 400, source: 'asr' });
    const unsure = classifyRelevance(nodes, context(), { acoustic: 0.2, audioMs: 400, source: 'asr' });
    expect(unsure.score).toBeLessThan(confident.score);
    expect(unsure.reasons.map((reason) => reason.code)).toContain('low_confidence_audio');
  });

  it('explains every decision in terms an operator can audit', () => {
    const decision = classify('can you pass me four instruments');
    expect(decision.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['question', 'request', 'non_clinical_words']),
    );
    expect(explainRelevance(decision)).toContain('request to another person');
  });

  it('treats an empty utterance as non-chartable rather than uncertain', () => {
    expect(classify('   ').label).toBe('non_chartable');
  });
});
