/**
 * Bounded candidate lattice.
 *
 * Short clinical words carry almost no linguistic context, so a recognizer that
 * heard the sound correctly still routinely picks the wrong word: "to" for two,
 * "for" for four, "ate" for eight, "forty" for fourteen. Committing the literal
 * transcript throws that information away.
 *
 * Instead every token becomes a small set of candidate readings with a prior.
 * The lattice itself is context-free; `contextResolver` decides which reading
 * the active clinical state permits. Candidate sets are deliberately small and
 * hand-curated: an unbounded phonetic expansion would let context invent values
 * that were never spoken.
 */

import { categoryOf, isCanonicalTerm } from './lexicon';
import type { AsrWord } from './types';

export type CandidateKind = 'number' | 'term' | 'filler' | 'unknown';
export type CandidateSource = 'literal' | 'homophone' | 'lexicon';

export interface Candidate {
  kind: CandidateKind;
  value: number | null;
  term: string | null;
  /** Context-free plausibility, 0..1. */
  prior: number;
  source: CandidateSource;
}

export interface LatticeNode {
  index: number;
  /** The token as it reached this stage, after lexicon canonicalization. */
  token: string;
  candidates: Candidate[];
  /** Recognizer word probability when word timings were available. */
  acoustic: number | null;
  startMs: number | null;
  endMs: number | null;
}

const UNITS: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
};

const TENS: Record<string, number> = { twenty: 20, thirty: 30 };

/**
 * Attested substitutions for spoken digits. Each entry is a word a recognizer
 * or a speaker's accent produces in place of the number, never a free phonetic
 * neighbour. `forty` for fourteen and its siblings matter because the wrong
 * reading is out of tooth range, so context can reject it decisively.
 */
const HOMOPHONES: Record<string, number> = {
  won: 1,
  wan: 1,
  juan: 1,
  to: 2,
  too: 2,
  tu: 2,
  tree: 3,
  free: 3,
  thee: 3,
  tre: 3,
  for: 4,
  fore: 4,
  faux: 4,
  foe: 4,
  fife: 5,
  hive: 5,
  sicks: 6,
  sics: 6,
  sex: 6,
  sevin: 7,
  ate: 8,
  ait: 8,
  eat: 8,
  nein: 9,
  nyne: 9,
  tin: 10,
  twelf: 12,
  forty: 14,
  fifty: 15,
  sixty: 16,
  seventy: 17,
  eighty: 18,
  ninety: 19,
};

/** Words that carry no clinical value but do not make an utterance casual. */
const FILLERS = new Set([
  'a',
  'and',
  'ah',
  'alright',
  'er',
  'erm',
  'hmm',
  'is',
  'its',
  'mm',
  'mmm',
  'now',
  'of',
  'ok',
  'okay',
  'right',
  'so',
  'the',
  'then',
  'uh',
  'um',
  'well',
]);

const LITERAL_DIGIT_PRIOR = 0.98;
const LITERAL_WORD_PRIOR = 0.95;
const LEXICON_PRIOR = 0.9;
const HOMOPHONE_PRIOR = 0.34;
const FILLER_PRIOR = 0.6;
const UNKNOWN_PRIOR = 0.5;

export function isFillerToken(token: string): boolean {
  return FILLERS.has(token);
}

/** True when a token could be read as a number, literally or as a substitution. */
export function isPotentialNumber(token: string): boolean {
  return /^\d{1,2}$/.test(token) || token in UNITS || token in HOMOPHONES;
}

export function literalNumber(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) return Number(token);
  return token in UNITS ? UNITS[token] : null;
}

export function homophoneNumber(token: string): number | null {
  return token in HOMOPHONES ? HOMOPHONES[token] : null;
}

/**
 * Merges spoken compound numbers into one token so "twenty eight" and
 * "twenty-eight" both become a single numeric node.
 */
export function mergeCompoundNumbers(tokens: readonly string[]): string[] {
  const merged: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const hyphenated = token.includes('-') ? token.split('-') : null;
    if (hyphenated && hyphenated.length === 2 && hyphenated[0] in TENS && hyphenated[1] in UNITS) {
      const value = TENS[hyphenated[0]] + UNITS[hyphenated[1]];
      merged.push(String(value));
      continue;
    }
    const next = tokens[index + 1];
    if (token in TENS && next !== undefined && next in UNITS && UNITS[next] >= 1 && UNITS[next] <= 9) {
      merged.push(String(TENS[token] + UNITS[next]));
      index += 1;
      continue;
    }
    merged.push(token);
  }
  return merged;
}

function candidatesFor(token: string): Candidate[] {
  const candidates: Candidate[] = [];
  const literal = literalNumber(token);
  if (literal !== null) {
    candidates.push({
      kind: 'number',
      value: literal,
      term: null,
      prior: /^\d+$/.test(token) ? LITERAL_DIGIT_PRIOR : LITERAL_WORD_PRIOR,
      source: 'literal',
    });
  }
  if (isCanonicalTerm(token)) {
    candidates.push({
      kind: 'term',
      value: null,
      term: token,
      prior: LEXICON_PRIOR,
      source: 'lexicon',
    });
  }
  const homophone = homophoneNumber(token);
  if (homophone !== null) {
    candidates.push({
      kind: 'number',
      value: homophone,
      term: null,
      prior: HOMOPHONE_PRIOR,
      source: 'homophone',
    });
  }
  if (candidates.length === 0) {
    candidates.push({
      kind: FILLERS.has(token) ? 'filler' : 'unknown',
      value: null,
      term: null,
      prior: FILLERS.has(token) ? FILLER_PRIOR : UNKNOWN_PRIOR,
      source: 'literal',
    });
  }
  return candidates;
}

export interface BuildLatticeOptions {
  words?: readonly AsrWord[];
}

/**
 * Builds the lattice from canonicalized tokens, attaching recognizer word
 * probabilities positionally when the word count still lines up. Canonicalizing
 * collapses phrases, so alignment is used only when it is unambiguous.
 */
export function buildLattice(
  tokens: readonly string[],
  options: BuildLatticeOptions = {},
): LatticeNode[] {
  const merged = mergeCompoundNumbers(tokens);
  const words = options.words ?? [];
  const aligned = words.length === merged.length;
  return merged.map((token, index) => ({
    index,
    token,
    candidates: candidatesFor(token),
    acoustic: aligned ? words[index].probability : null,
    startMs: aligned ? words[index].startMs : null,
    endMs: aligned ? words[index].endMs : null,
  }));
}

/** Mean recognizer confidence across the utterance, or null when unavailable. */
export function acousticConfidence(nodes: readonly LatticeNode[]): number | null {
  const scores = nodes.map((node) => node.acoustic).filter((score): score is number => score !== null);
  if (scores.length === 0) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

/** True when the node has a clinical term reading, used by relevance scoring. */
export function hasClinicalTerm(node: LatticeNode): boolean {
  return node.candidates.some(
    (candidate) => candidate.kind === 'term' && candidate.term !== null && categoryOf(candidate.term) !== null,
  );
}
