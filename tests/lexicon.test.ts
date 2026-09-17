import { describe, expect, it } from 'vitest';
import {
  LEXICON,
  LEXICON_VERSION,
  canonicalize,
  canonicalTerms,
  categoryOf,
  dentalPrompt,
  promptTerms,
  promptVersion,
  variantCount,
} from '../src/domain/lexicon';

const text = (value: string, contextual = false) =>
  canonicalize(value, { contextual }).tokens.join(' ');

describe('dental lexicon', () => {
  it('is versioned so a vocabulary change can be traced through evaluation reports', () => {
    expect(LEXICON_VERSION).toMatch(/^\d{4}\.\d{2}\.\d+$/);
    expect(variantCount()).toBeGreaterThan(150);
  });

  it('keeps every canonical token single-word so the grammar can match on tokens', () => {
    for (const entry of LEXICON) {
      expect(entry.canonical, `${entry.canonical} must be one token`).not.toContain(' ');
    }
  });

  it('never maps one spelling onto two different canonical terms', () => {
    const seen = new Map<string, string>();
    for (const entry of LEXICON) {
      for (const variant of entry.safe) {
        const previous = seen.get(variant);
        expect(previous ?? entry.canonical).toBe(entry.canonical);
        seen.set(variant, entry.canonical);
      }
    }
  });

  it('expands spoken clinical abbreviations', () => {
    expect(text('b o p')).toBe('bleeding');
    expect(text('p d three four five')).toBe('depth three four five');
    expect(text('m b four')).toBe('site-mb four');
    expect(text('d l six')).toBe('site-dl six');
    expect(text('c a l')).toBe('attachment');
  });

  it('collapses multi-word terminology to one canonical token, longest match first', () => {
    expect(text('probing depth')).toBe('depth');
    expect(text('bleeding on probing')).toBe('bleeding');
    expect(text('furcation involvement')).toBe('furcation');
    expect(text('mesial buccal')).toBe('site-mb');
    expect(text('upper right')).toBe('quadrant-ur');
  });

  it('repairs recognizer spellings of clinical vocabulary without any context', () => {
    expect(text('buccle')).toBe('buccal');
    expect(text('facial')).toBe('buccal');
    expect(text('palatal')).toBe('lingual');
    expect(text('fur cation')).toBe('furcation');
    expect(text('supperation')).toBe('suppuration');
    expect(text('tartar')).toBe('calculus');
  });

  it('leaves ordinary English alone until the utterance is judged clinical', () => {
    expect(text('can you pass me that buckle')).toContain('buckle');
    expect(text('the black one')).toContain('black');
    expect(text('we can book a vacation')).toContain('vacation');

    expect(text('buckle', true)).toBe('buccal');
    expect(text('vacation', true)).toBe('furcation');
    expect(text('nobility two', true)).toBe('mobility two');
  });

  it('reports what it rewrote, with the risk class that allowed it', () => {
    const safe = canonicalize('tartar');
    expect(safe.replacements).toEqual([{ from: 'tartar', to: 'calculus', index: 0, risk: 'safe' }]);

    const contextual = canonicalize('black', { contextual: true });
    expect(contextual.replacements[0]).toMatchObject({ to: 'plaque', risk: 'contextual' });
  });

  it('records no replacement when speech already uses canonical vocabulary', () => {
    const result = canonicalize('bleeding buccal depth');
    expect(result.tokens).toEqual(['bleeding', 'buccal', 'depth']);
    expect(result.replacements).toEqual([]);
  });

  it('classifies canonical tokens for downstream stages', () => {
    expect(categoryOf('bleeding')).toBe('finding');
    expect(categoryOf('depth')).toBe('measurement');
    expect(categoryOf('buccal')).toBe('surface');
    expect(categoryOf('skip')).toBe('command');
    expect(categoryOf('threadbare')).toBeNull();
    expect(canonicalTerms()).toContain('furcation');
  });

  it('shares one recognizer prompt with the Python service and keeps it complete', () => {
    const prompt = dentalPrompt();
    for (const term of promptTerms()) {
      expect(prompt, `prompt is missing "${term}"`).toContain(term);
    }
    expect(promptVersion()).toBe(LEXICON_VERSION);
    expect(prompt.length).toBeLessThan(600);
  });
});
