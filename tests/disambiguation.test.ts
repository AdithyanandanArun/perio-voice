import { describe, expect, it } from 'vitest';
import { buildLattice, isPotentialNumber, mergeCompoundNumbers } from '../src/domain/lattice';
import { canonicalize } from '../src/domain/lexicon';
import {
  deriveExpectation,
  resolveWithContext,
  resolvedNumbers,
  resolvedText,
} from '../src/domain/contextResolver';
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

function resolve(phrase: string, overrides: Partial<ClinicalContext> = {}) {
  const { tokens } = canonicalize(phrase, { contextual: true });
  return resolveWithContext(buildLattice(tokens), context(overrides));
}

describe('candidate lattice', () => {
  it('merges spoken compound numbers into one node', () => {
    expect(mergeCompoundNumbers(['twenty', 'eight'])).toEqual(['28']);
    expect(mergeCompoundNumbers(['thirty-two'])).toEqual(['32']);
    expect(mergeCompoundNumbers(['twenty', 'bleeding'])).toEqual(['twenty', 'bleeding']);
  });

  it('offers a substituted reading alongside the literal word', () => {
    const [node] = buildLattice(['for']);
    expect(node.candidates.map((candidate) => candidate.value)).toContain(4);
    expect(node.candidates.find((candidate) => candidate.value === 4)?.source).toBe('homophone');
  });

  it('recognizes which tokens could carry a number at all', () => {
    expect(isPotentialNumber('ate')).toBe(true);
    expect(isPotentialNumber('7')).toBe(true);
    expect(isPotentialNumber('instruments')).toBe(false);
  });

  it('attaches recognizer word probabilities when the alignment is unambiguous', () => {
    const words = [
      { word: 'three', startMs: 0, endMs: 300, probability: 0.91 },
      { word: 'four', startMs: 300, endMs: 600, probability: 0.44 },
    ];
    const nodes = buildLattice(['three', 'four'], { words });
    expect(nodes[1].acoustic).toBeCloseTo(0.44);
    expect(buildLattice(['three'], { words })[0].acoustic).toBeNull();
  });
});

describe('context-aware disambiguation', () => {
  it('reads short homophones as depths while depths are expected', () => {
    expect(resolvedNumbers(resolve('to for ate').tokens)).toEqual([2, 4, 8]);
    expect(resolvedNumbers(resolve('tree free').tokens)).toEqual([3, 3]);
  });

  it('refuses to invent a value once nothing numeric is expected', () => {
    const result = resolve('to for ate', { position: 3 });
    expect(resolvedNumbers(result.tokens)).toEqual([]);
    expect(resolvedText(result.tokens)).toBe('to for ate');
  });

  it('never lets a substitution produce a value outside the open window', () => {
    // "tin" is a known substitution for ten, which is a legal depth...
    expect(resolvedNumbers(resolve('tin').tokens)).toEqual([10]);
    // ...but not a legal mobility grade, so the same word stays a word.
    const graded = resolve('mobility tin');
    expect(resolvedNumbers(graded.tokens)).toEqual([]);
  });

  it('repairs a tooth number that was heard as a multiple of ten', () => {
    const result = resolve('tooth forty');
    expect(resolvedNumbers(result.tokens)).toEqual([14]);
    expect(result.ambiguities[0]).toMatchObject({ token: 'forty', chosen: 'forty→14' });
  });

  it('leaves a literal out-of-range number intact so validation can reject it', () => {
    expect(resolvedNumbers(resolve('three thirteen five').tokens)).toEqual([3, 13, 5]);
  });

  it('opens a tooth window only when the utterance refers to a tooth', () => {
    const withTooth = deriveExpectation(context(), buildLattice(canonicalize('tooth').tokens));
    expect(withTooth.windows.map((window) => window.reason)).toContain('tooth');

    const withoutTooth = deriveExpectation(context(), buildLattice(['five']));
    expect(withoutTooth.windows.every((window) => window.reason !== 'tooth')).toBe(true);
  });

  it('switches the value window when the clinician names recession', () => {
    const expectation = deriveExpectation(
      context(),
      buildLattice(canonicalize('gingival recession zero').tokens),
    );
    expect(expectation.measurement).toBe('recession');
    expect(resolvedNumbers(resolve('recession zero one two').tokens)).toEqual([0, 1, 2]);
    // Zero is not a legal probing depth, so the same word is not a depth reading.
    expect(resolvedNumbers(resolve('zero').tokens)).toEqual([0]);
  });

  it('reopens the measurement window on a finished station for an explicit repeat', () => {
    const result = resolve('repeat that three four four', { position: 3 });
    expect(resolvedNumbers(result.tokens)).toEqual([3, 4, 4]);
  });

  it('binds a number after a grade term to the grade window only', () => {
    // Sites are still open, so the probing-depth window is available, but "tin"
    // follows a graded finding and ten is not a mobility grade.
    const result = resolve('mobility tin');
    expect(resolvedNumbers(result.tokens)).toEqual([]);
    expect(resolvedNumbers(resolve('mobility two').tokens)).toEqual([2]);
  });

  it('resolves a long utterance inside the declared 20 ms disambiguation budget', () => {
    const phrase = Array.from({ length: 12 }, () => 'to for ate tooth forty bleeding').join(' ');
    const { tokens } = canonicalize(phrase, { contextual: true });
    const nodes = buildLattice(tokens);
    const started = performance.now();
    for (let run = 0; run < 20; run += 1) resolveWithContext(nodes, context());
    const perRun = (performance.now() - started) / 20;
    expect(perRun).toBeLessThan(20);
  });

  it('reports each ambiguity it resolved for telemetry and operator review', () => {
    const result = resolve('to for ate');
    expect(result.ambiguities).toHaveLength(3);
    expect(result.ambiguities[0]).toMatchObject({ chosen: 'to→2', confidence: expect.any(Number) });
  });
});
