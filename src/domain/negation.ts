/**
 * Negation handling.
 *
 * "Bleeding" and "no bleeding" differ by one short word and mean opposite
 * things in the record, so polarity is resolved by an explicit scope parser
 * rather than by a substring test. A cue opens a negative scope that travels
 * forward over the findings it governs and closes at the first thing that
 * cannot belong to the same clause.
 *
 * Every assertion carries the cue, the token span it covers and a confidence.
 * Constructions where English itself is ambiguous — a conjunction after a cue,
 * a trailing cue, a doubled cue — resolve to a definite polarity with reduced
 * confidence, and the pipeline asks the clinician to confirm those rather than
 * writing a reversed finding silently.
 */

import { GRADED_FINDINGS, type FindingType } from './types';
import type { ResolvedToken } from './contextResolver';

export type Polarity = 'positive' | 'negative';

export interface FindingAssertion {
  finding: FindingType;
  polarity: Polarity;
  grade: number | null;
  cue: string | null;
  cueIndex: number | null;
  scopeStart: number;
  scopeEnd: number;
  confidence: number;
}

/** Below this, polarity is asked about instead of written. */
export const POLARITY_CONFIRM_THRESHOLD = 0.75;

const SINGLE_CUES = new Set(['no', 'not', 'without', 'none', 'negative', 'denies', 'absent', 'nil', 'non']);
const PHRASE_CUES: readonly (readonly string[])[] = [
  ['negative', 'for'],
  ['free', 'of'],
  ['no', 'evidence', 'of'],
  ['no', 'sign', 'of'],
  ['no', 'signs', 'of'],
];
const CONJUNCTIONS = new Set(['or', 'and', 'nor']);
const SCOPE_BREAKERS = new Set(['but', 'however', 'though', 'sorry', 'actually', 'correction', 'instead']);

const FINDING_TERMS = new Set<FindingType>([
  'bleeding',
  'suppuration',
  'plaque',
  'calculus',
  'mobility',
  'furcation',
]);

const GRADED = new Set<string>(GRADED_FINDINGS);

/** How far a negative scope may reach past its cue before it is judged closed. */
const MAX_SCOPE_DISTANCE = 4;

const CONFIDENCE_ADJACENT = 0.95;
const CONFIDENCE_NEAR = 0.85;
const CONFIDENCE_CONJUNCTION = 0.7;
const CONFIDENCE_TRAILING = 0.7;
const CONFIDENCE_DOUBLE = 0.6;

function isFindingTerm(token: ResolvedToken): token is ResolvedToken & { term: FindingType } {
  return token.kind === 'term' && token.term !== null && FINDING_TERMS.has(token.term as FindingType);
}

function cueAt(tokens: readonly ResolvedToken[], index: number): { cue: string; length: number } | null {
  for (const phrase of PHRASE_CUES) {
    const slice = tokens.slice(index, index + phrase.length).map((token) => token.token);
    if (slice.length === phrase.length && slice.every((token, offset) => token === phrase[offset])) {
      return { cue: phrase.join(' '), length: phrase.length };
    }
  }
  const token = tokens[index];
  if (token !== undefined && SINGLE_CUES.has(token.token)) return { cue: token.token, length: 1 };
  return null;
}

/**
 * A bare "no" before a number is a self-correction ("four no three"), not a
 * negated finding. Only a cue that governs a finding counts as negation.
 */
function governsFinding(tokens: readonly ResolvedToken[], from: number): boolean {
  for (let index = from; index < Math.min(tokens.length, from + MAX_SCOPE_DISTANCE + 1); index += 1) {
    const token = tokens[index];
    if (isFindingTerm(token)) return true;
    if (token.kind === 'number') return false;
    if (SCOPE_BREAKERS.has(token.token)) return false;
  }
  return false;
}

interface GradeBinding {
  value: number;
  indices: number[];
}

/**
 * Binds an ordinal grade to a graded finding. Only the two spoken orders are
 * accepted — "mobility two", "mobility grade two" and "grade two mobility" —
 * so a nearby measurement cannot be mistaken for a grade.
 */
function gradeFor(tokens: readonly ResolvedToken[], index: number): GradeBinding | null {
  const first = tokens[index + 1];
  if (first !== undefined && first.kind === 'number' && first.value !== null) {
    return { value: first.value, indices: [index + 1] };
  }
  if (first !== undefined && first.kind === 'term' && first.term === 'grade') {
    const second = tokens[index + 2];
    if (second !== undefined && second.kind === 'number' && second.value !== null) {
      return { value: second.value, indices: [index + 1, index + 2] };
    }
  }
  const previous = tokens[index - 1];
  const beforePrevious = tokens[index - 2];
  if (
    previous !== undefined
    && previous.kind === 'number'
    && previous.value !== null
    && beforePrevious !== undefined
    && beforePrevious.kind === 'term'
    && beforePrevious.term === 'grade'
  ) {
    return { value: previous.value, indices: [index - 2, index - 1] };
  }
  return null;
}

export interface NegationResult {
  assertions: FindingAssertion[];
  /** Token indices consumed by findings, so the grammar does not reuse them. */
  consumed: Set<number>;
  /** Indices of words used as negation cues, so they are not read as corrections. */
  cues: Set<number>;
}

export function resolveAssertions(tokens: readonly ResolvedToken[]): NegationResult {
  const assertions: FindingAssertion[] = [];
  const consumed = new Set<number>();
  const cues = new Set<number>();

  let scopeCue: string | null = null;
  let scopeIndex: number | null = null;
  let scopeDistance = 0;
  let scopeConfidence = CONFIDENCE_ADJACENT;
  let doubled = false;

  const closeScope = (): void => {
    scopeCue = null;
    scopeIndex = null;
    scopeDistance = 0;
    doubled = false;
    scopeConfidence = CONFIDENCE_ADJACENT;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const cue = cueAt(tokens, index);

    if (cue !== null) {
      if (scopeCue !== null && scopeDistance === 0) {
        // Two cues in a row cancel: "no, no bleeding" asserts bleeding.
        doubled = true;
        scopeConfidence = CONFIDENCE_DOUBLE;
        index += cue.length - 1;
        continue;
      }
      if (!governsFinding(tokens, index + cue.length)) {
        closeScope();
        continue;
      }
      scopeCue = cue.cue;
      scopeIndex = index;
      for (let offset = 0; offset < cue.length; offset += 1) cues.add(index + offset);
      scopeDistance = 0;
      scopeConfidence = CONFIDENCE_ADJACENT;
      doubled = false;
      index += cue.length - 1;
      continue;
    }

    if (isFindingTerm(token)) {
      const finding = token.term;
      const negated = scopeCue !== null && !doubled;
      const binding = GRADED.has(finding) ? gradeFor(tokens, index) : null;
      const grade = binding?.value ?? null;
      assertions.push({
        finding,
        polarity: negated ? 'negative' : 'positive',
        grade: negated && grade === null ? 0 : grade,
        cue: scopeCue,
        cueIndex: scopeIndex,
        scopeStart: scopeIndex ?? index,
        scopeEnd: index,
        confidence: scopeCue === null ? CONFIDENCE_ADJACENT : scopeConfidence,
      });
      consumed.add(index);
      for (const consumedIndex of binding?.indices ?? []) consumed.add(consumedIndex);
      scopeDistance = 0;
      continue;
    }

    if (scopeCue === null) continue;

    if (CONJUNCTIONS.has(token.token)) {
      // "no bleeding or suppuration" keeps the scope; "and" is weaker English,
      // so the polarity it produces is offered for confirmation.
      if (token.token === 'and') scopeConfidence = Math.min(scopeConfidence, CONFIDENCE_CONJUNCTION);
      continue;
    }

    if (SCOPE_BREAKERS.has(token.token) || token.kind === 'number') {
      closeScope();
      continue;
    }

    scopeDistance += 1;
    if (scopeDistance === 1) scopeConfidence = Math.min(scopeConfidence, CONFIDENCE_NEAR);
    if (scopeDistance > MAX_SCOPE_DISTANCE) closeScope();
  }

  applyTrailingCue(tokens, assertions, cues);
  return { assertions, consumed, cues };
}

/** "Bleeding, no" reverses the finding it follows, at reduced confidence. */
function applyTrailingCue(
  tokens: readonly ResolvedToken[],
  assertions: FindingAssertion[],
  cues: Set<number>,
): void {
  const last = tokens[tokens.length - 1];
  if (last === undefined || !SINGLE_CUES.has(last.token) || assertions.length === 0) return;
  const target = assertions[assertions.length - 1];
  if (target.scopeEnd >= tokens.length - 1 || target.polarity === 'negative') return;
  cues.add(tokens.length - 1);
  assertions[assertions.length - 1] = {
    ...target,
    polarity: 'negative',
    grade: target.grade === null ? 0 : target.grade,
    cue: last.token,
    cueIndex: tokens.length - 1,
    scopeEnd: tokens.length - 1,
    confidence: CONFIDENCE_TRAILING,
  };
}

export function needsPolarityConfirmation(assertion: FindingAssertion): boolean {
  return assertion.confidence < POLARITY_CONFIRM_THRESHOLD;
}

export function describeAssertion(assertion: FindingAssertion): string {
  const value = assertion.polarity === 'positive' ? 'present' : 'absent';
  if (assertion.grade !== null && assertion.polarity === 'positive') {
    return `${assertion.finding} grade ${assertion.grade}`;
  }
  return `${assertion.finding} ${value}`;
}
