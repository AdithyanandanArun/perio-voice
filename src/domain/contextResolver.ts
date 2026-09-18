/**
 * Context-aware disambiguation.
 *
 * The lattice supplies possible readings; this stage decides which one the
 * active clinical state permits. The rule that makes it safe is structural
 * rather than statistical: a substituted reading is only ever offered when the
 * context already expects a value in that range, so context can correct a
 * misheard word but can never manufacture a measurement that was not spoken.
 *
 * A literal out-of-range number is deliberately left alone. "Three thirteen
 * five" must reach the range validator and be rejected as a unit, not be
 * quietly repaired into something plausible.
 */

import {
  MAX_DEPTH_MM,
  MAX_FURCATION_GRADE,
  MAX_MOBILITY_GRADE,
  MAX_RECESSION_MM,
  MAX_TOOTH,
  MIN_DEPTH_MM,
  MIN_RECESSION_MM,
  MIN_TOOTH,
  type ClinicalContext,
  type MeasurementType,
} from './types';
import type { Candidate, CandidateKind, CandidateSource, LatticeNode } from './lattice';

export interface ValueWindow {
  readonly min: number;
  readonly max: number;
  readonly reason: 'measurement' | 'tooth' | 'grade';
}

export interface ClinicalExpectation {
  measurement: MeasurementType;
  remainingSites: number;
  toothMentioned: boolean;
  gradeMentioned: boolean;
  windows: ValueWindow[];
}

export interface ResolvedToken {
  index: number;
  token: string;
  kind: CandidateKind;
  value: number | null;
  term: string | null;
  confidence: number;
  source: CandidateSource;
}

export interface AmbiguityResolution {
  index: number;
  token: string;
  chosen: string;
  rejected: string[];
  confidence: number;
}

export interface ResolutionResult {
  tokens: ResolvedToken[];
  ambiguities: AmbiguityResolution[];
  expectation: ClinicalExpectation;
}

const TOOTH_MARKERS = new Set(['tooth', 'quadrant-ur', 'quadrant-ul', 'quadrant-ll', 'quadrant-lr']);
const GRADE_MARKERS = new Set(['mobility', 'furcation', 'grade']);

/**
 * Verbs that move charting position rather than name a value. "to"/"for" right
 * next to one of these (or right before a tooth reference) are function words
 * of a navigation phrase, never a measurement — this is checked on the raw
 * token text, before any context window is consulted, so it holds regardless
 * of what a station happens to be waiting for.
 */
const NAVIGATION_VERBS = new Set([
  'go',
  'move',
  'jump',
  'switch',
  'skip',
  'back',
  'take',
  'head',
  'return',
  'come',
]);
/** A pronoun that can sit between a navigation verb and "to" ("take me to"). */
const NAVIGATION_PRONOUNS = new Set(['me', 'us']);

/** True when the very next token is the tooth (or quadrant) reference itself. */
function precedesToothReference(nodes: readonly LatticeNode[], index: number): boolean {
  const next = nodes[index + 1];
  return next !== undefined && TOOTH_MARKERS.has(next.token);
}

/** True when the token immediately follows a navigation verb, one pronoun apart at most. */
function followsNavigationVerb(nodes: readonly LatticeNode[], index: number): boolean {
  const prev = nodes[index - 1];
  if (prev === undefined) return false;
  if (NAVIGATION_VERBS.has(prev.token)) return true;
  if (NAVIGATION_PRONOUNS.has(prev.token)) {
    const before = nodes[index - 2];
    return before !== undefined && NAVIGATION_VERBS.has(before.token);
  }
  return false;
}

/**
 * True when this token sits in a navigation phrase's function-word slot, so a
 * phonetic substitution (`to`→2, `for`→4) it might carry is never a value
 * candidate — no window, however open, can override this. This is the
 * structural half of admissibility: it runs on token adjacency alone, not on
 * what the clinical context is waiting for.
 */
function inNavigationSlot(nodes: readonly LatticeNode[], index: number): boolean {
  return precedesToothReference(nodes, index) || followsNavigationVerb(nodes, index);
}

/** Boost applied to a reading the active clinical context is waiting for. */
const IN_CONTEXT_BOOST = 1.6;
/** Penalty for a literal number nothing expects; it must still reach validation. */
const OUT_OF_CONTEXT_PENALTY = 0.5;
const CLINICAL_TERM_BOOST = 1.2;

/** Used when context rules out every candidate the lattice offered. */
const UNRESOLVED: Candidate = {
  kind: 'unknown',
  value: null,
  term: null,
  prior: 0.5,
  source: 'literal',
};

function measurementWindow(measurement: MeasurementType): ValueWindow {
  return measurement === 'recession'
    ? { min: MIN_RECESSION_MM, max: MAX_RECESSION_MM, reason: 'measurement' }
    : { min: MIN_DEPTH_MM, max: MAX_DEPTH_MM, reason: 'measurement' };
}

export function deriveExpectation(
  context: ClinicalContext,
  nodes: readonly LatticeNode[],
): ClinicalExpectation {
  const terms = new Set(
    nodes.flatMap((node) =>
      node.candidates
        .filter((candidate) => candidate.kind === 'term' && candidate.term !== null)
        .map((candidate) => candidate.term as string),
    ),
  );
  const measurement: MeasurementType = terms.has('recession')
    ? 'recession'
    : terms.has('depth')
      ? 'probing_depth'
      : context.measurement;
  const toothMentioned = [...TOOTH_MARKERS].some((marker) => terms.has(marker));
  const gradeMentioned = [...GRADE_MARKERS].some((marker) => terms.has(marker));
  const remainingSites = Math.max(0, context.expectedValues - context.position);

  const windows: ValueWindow[] = [];
  // An explicit measurement word re-opens the window even on a finished station,
  // because the clinician is starting a new measurement pass.
  if (remainingSites > 0 || terms.has('depth') || terms.has('recession') || terms.has('repeat')) {
    windows.push(measurementWindow(measurement));
  }
  if (toothMentioned) windows.push({ min: MIN_TOOTH, max: MAX_TOOTH, reason: 'tooth' });
  if (gradeMentioned) {
    const max = terms.has('furcation') ? MAX_FURCATION_GRADE : MAX_MOBILITY_GRADE;
    windows.push({ min: 0, max, reason: 'grade' });
  }
  return { measurement, remainingSites, toothMentioned, gradeMentioned, windows };
}

export function windowsAllow(windows: readonly ValueWindow[], value: number): boolean {
  return windows.some((window) => value >= window.min && value <= window.max);
}

function acousticFactor(acoustic: number | null): number {
  return acoustic === null ? 1 : 0.5 + 0.5 * acoustic;
}

function describe(candidate: Candidate, token: string): string {
  if (candidate.kind === 'number') return `${token}→${candidate.value}`;
  if (candidate.kind === 'term') return `${token}→${candidate.term}`;
  return token;
}

function score(
  candidate: Candidate,
  windows: readonly ValueWindow[],
  acoustic: number | null,
): number {
  const base = candidate.prior * acousticFactor(acoustic);
  if (candidate.kind === 'number' && candidate.value !== null) {
    if (windows.length === 0) return base * OUT_OF_CONTEXT_PENALTY;
    return windowsAllow(windows, candidate.value)
      ? base * IN_CONTEXT_BOOST
      : base * OUT_OF_CONTEXT_PENALTY;
  }
  if (candidate.kind === 'term') return base * CLINICAL_TERM_BOOST;
  return base;
}

/**
 * A substituted number is admissible only inside a window the context already
 * opened. Dropping it outright — rather than scoring it low — is what keeps
 * context from inventing values.
 */
function admissible(
  candidate: Candidate,
  windows: readonly ValueWindow[],
  navigationSlot: boolean,
): boolean {
  if (candidate.source !== 'homophone') return true;
  if (navigationSlot) return false;
  if (candidate.value === null) return false;
  return windows.length > 0 && windowsAllow(windows, candidate.value);
}

/**
 * A number directly after a binding term belongs to that binding, so only that
 * binding's window is open for it. Without this, "mobility ten" would borrow the
 * probing-depth window and produce a grade nothing could have meant.
 */
function narrowWindows(
  expectation: ClinicalExpectation,
  previous: ResolvedToken | null,
): ValueWindow[] {
  const term = previous?.kind === 'term' ? previous.term : null;
  if (term !== null) {
    if (GRADE_MARKERS.has(term)) return expectation.windows.filter((w) => w.reason === 'grade');
    if (TOOTH_MARKERS.has(term)) return expectation.windows.filter((w) => w.reason === 'tooth');
  }
  return expectation.windows;
}

export function resolveWithContext(
  nodes: readonly LatticeNode[],
  context: ClinicalContext,
): ResolutionResult {
  const expectation = deriveExpectation(context, nodes);
  const tokens: ResolvedToken[] = [];
  const ambiguities: AmbiguityResolution[] = [];

  for (const node of nodes) {
    const windows = narrowWindows(expectation, tokens[tokens.length - 1] ?? null);
    const navigationSlot = inNavigationSlot(nodes, node.index);
    const usable = node.candidates.filter((candidate) => admissible(candidate, windows, navigationSlot));
    const pool = usable.length > 0 ? usable : [UNRESOLVED];
    let best = pool[0];
    let bestScore = score(best, windows, node.acoustic);
    for (const candidate of pool.slice(1)) {
      const candidateScore = score(candidate, windows, node.acoustic);
      if (candidateScore > bestScore) {
        best = candidate;
        bestScore = candidateScore;
      }
    }
    tokens.push({
      index: node.index,
      token: node.token,
      kind: best.kind,
      value: best.value,
      term: best.term,
      confidence: Math.min(1, bestScore),
      source: best.source,
    });
    const rejected = pool.filter((candidate) => candidate !== best);
    if (best.source === 'homophone' || (rejected.length > 0 && best.kind !== 'unknown')) {
      ambiguities.push({
        index: node.index,
        token: node.token,
        chosen: describe(best, node.token),
        rejected: rejected.map((candidate) => describe(candidate, node.token)),
        confidence: Math.min(1, bestScore),
      });
    }
  }
  return { tokens, ambiguities, expectation };
}

/** Numeric readings in order, for the grammar stage. */
export function resolvedNumbers(tokens: readonly ResolvedToken[]): number[] {
  return tokens
    .filter((token) => token.kind === 'number' && token.value !== null)
    .map((token) => token.value as number);
}

export function resolvedText(tokens: readonly ResolvedToken[]): string {
  return tokens
    .map((token) => (token.kind === 'number' && token.value !== null ? String(token.value) : token.term ?? token.token))
    .join(' ');
}
