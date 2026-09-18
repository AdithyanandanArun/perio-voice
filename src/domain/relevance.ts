/**
 * Irrelevant-speech filtering.
 *
 * A clinician talks to the patient, to an assistant and to themselves while
 * charting. Only a fraction of that speech belongs in the record, and forcing
 * the clinician to arm and disarm the microphone defeats the point of hands-free
 * capture. This stage scores an utterance before anything parses it.
 *
 * The scoring is deliberately explainable: weighted evidence for and against
 * chartability, each with a code the interface and the evaluation harness can
 * display. Borderline speech is labelled `uncertain`, shown to the clinician and
 * held for confirmation rather than committed, because the expensive failure is
 * a false chart entry, not a missed one the clinician can simply repeat.
 */

import { categoryOf } from './lexicon';
import { isFillerToken, isPotentialNumber, type LatticeNode } from './lattice';
import { SITES_PER_STATION, type ClinicalContext, type UtteranceSource } from './types';

export type RelevanceLabel = 'chartable' | 'non_chartable' | 'uncertain';

export interface RelevanceReason {
  code: string;
  weight: number;
  detail: string;
}

export interface RelevanceDecision {
  label: RelevanceLabel;
  score: number;
  reasons: RelevanceReason[];
}

export interface RelevanceSignals {
  /** Mean recognizer word probability, when word timings were available. */
  acoustic: number | null;
  audioMs: number | null;
  source: UtteranceSource;
}

export const CHARTABLE_THRESHOLD = 0.35;
export const NON_CHARTABLE_THRESHOLD = -0.15;

interface CuePattern {
  code: string;
  weight: number;
  pattern: RegExp;
  detail: string;
}

/**
 * Phrase cues. Each one is speech that is unambiguously aimed at a person
 * rather than at the record; none of them can appear inside a measurement.
 */
const NEGATIVE_CUES: readonly CuePattern[] = [
  {
    code: 'patient_directed',
    weight: -0.62,
    pattern: /\b(?:you might feel|you'?ll feel|little pressure|bit of pressure|almost done|hang in there|doing (?:great|well|fine)|open (?:wide|wider)|bite down|rinse|spit|relax|let me know if)\b/,
    detail: 'speech aimed at the patient',
  },
  {
    code: 'request',
    weight: -0.58,
    pattern: /\b(?:pass me|hand me|give me|grab (?:me|the)|can i get|could i get|let'?s|let me get|bring me|i need the)\b/,
    detail: 'a request to another person',
  },
  {
    code: 'question',
    weight: -0.5,
    pattern: /^(?:can|could|would|will|do|does|did|how|what|where|when|why|is|are|any)\b/,
    detail: 'an interrogative opening',
  },
  {
    code: 'second_person',
    weight: -0.45,
    pattern: /\b(?:you|your|you'?re|you'?ll|yours)\b/,
    detail: 'addressed to another person',
  },
  {
    code: 'hedging',
    weight: -0.4,
    pattern: /\b(?:i think|i guess|maybe|probably|looks (?:fine|good|ok|okay)|this looks|that looks|seems (?:fine|ok|okay)|take another look|we'?ll (?:take|check|look)|later on|for now)\b/,
    detail: 'thinking aloud rather than charting',
  },
  {
    code: 'small_talk',
    weight: -0.5,
    pattern: /\b(?:how are|weather|weekend|holiday|thanks|thank you|no problem|sorry about|good morning|good afternoon)\b/,
    detail: 'conversational filler',
  },
  {
    code: 'politeness',
    weight: -0.3,
    pattern: /\b(?:please|if you don'?t mind|when you get a chance)\b/,
    detail: 'a politeness marker, typical of speech to a person',
  },
  {
    code: 'procedural_talk',
    weight: -0.42,
    pattern: /\b(?:next patient|schedule|appointment|insurance|room (?:one|two|three|\d)|lunch|break room|call them|follow up)\b/,
    detail: 'practice logistics rather than clinical data',
  },
];

/** Words that are neither clinical anchors nor evidence of conversation. */
const NEUTRAL = new Set([
  // A function word, not evidence of conversation. Large recognizers also write
  // a short "four" as "or", and "four no three" arrived as "or no three": scoring
  // "or" as foreign vocabulary pushed a real correction into the held band.
  'or',
  'that',
  'this',
  'it',
  'there',
  'here',
  'at',
  'on',
  'in',
  'with',
  'to',
  'no',
  'not',
  'none',
  'without',
  'negative',
  'sorry',
  'actually',
  'correction',
  'make',
  'instead',
  'rather',
  'meant',
  'again',
  'more',
  'same',
  'point',
  'sites',
  'site',
  'mm',
]);

const ANCHOR_CATEGORIES = new Set(['finding', 'measurement', 'surface', 'site', 'region', 'command']);

function contentTokens(nodes: readonly LatticeNode[]): LatticeNode[] {
  return nodes.filter((node) => !isFillerToken(node.token));
}

function anchorTerms(nodes: readonly LatticeNode[]): string[] {
  const terms: string[] = [];
  for (const node of nodes) {
    const category = categoryOf(node.token);
    if (category !== null && ANCHOR_CATEGORIES.has(category)) terms.push(node.token);
  }
  return terms;
}

/**
 * True when every content token could be part of a spoken measurement. This is
 * the signal that admits "three four five" and "to for ate" while rejecting
 * "pass me four instruments", where the number is surrounded by ordinary words.
 */
export function isMeasurementPhrase(nodes: readonly LatticeNode[]): boolean {
  const content = contentTokens(nodes);
  if (content.length === 0) return false;
  let sawNumber = false;
  for (const node of content) {
    if (isPotentialNumber(node.token)) {
      sawNumber = true;
      continue;
    }
    if (NEUTRAL.has(node.token)) continue;
    const category = categoryOf(node.token);
    if (category !== null && ANCHOR_CATEGORIES.has(category)) continue;
    if (category === 'modifier' || category === 'anatomy') continue;
    return false;
  }
  return sawNumber;
}

export function classifyRelevance(
  nodes: readonly LatticeNode[],
  context: ClinicalContext,
  signals: RelevanceSignals,
): RelevanceDecision {
  const reasons: RelevanceReason[] = [];
  const text = nodes.map((node) => node.token).join(' ');
  const content = contentTokens(nodes);

  if (content.length === 0) {
    return {
      label: 'non_chartable',
      score: -1,
      reasons: [{ code: 'empty', weight: -1, detail: 'no content words' }],
    };
  }

  const anchors = anchorTerms(nodes);
  const numbers = content.filter((node) => isPotentialNumber(node.token));
  const remaining = Math.max(0, SITES_PER_STATION - context.position);

  if (isMeasurementPhrase(nodes)) {
    reasons.push({
      code: 'measurement_phrase',
      weight: 0.6,
      detail: 'every content word fits a spoken measurement',
    });
    if (numbers.length > 0 && numbers.length === remaining) {
      reasons.push({
        code: 'expected_count',
        weight: 0.2,
        detail: `value count matches the ${remaining} open sites`,
      });
    }
  }

  if (anchors.length > 0) {
    reasons.push({
      code: 'clinical_term',
      weight: Math.min(0.45, 0.3 * anchors.length),
      detail: `clinical vocabulary: ${[...new Set(anchors)].join(', ')}`,
    });
  }

  if (nodes.some((node) => node.token === 'tooth') && numbers.length > 0) {
    reasons.push({ code: 'context_command', weight: 0.4, detail: 'names a tooth and a number' });
  }

  if (content.length <= 4 && anchors.length > 0) {
    reasons.push({ code: 'terse_clinical', weight: 0.15, detail: 'short clinical utterance' });
  }

  for (const cue of NEGATIVE_CUES) {
    if (cue.pattern.test(text)) {
      reasons.push({ code: cue.code, weight: cue.weight, detail: cue.detail });
    }
  }

  const unknown = content.filter(
    (node) =>
      !isPotentialNumber(node.token)
      && !NEUTRAL.has(node.token)
      && categoryOf(node.token) === null,
  );
  if (unknown.length > 0) {
    reasons.push({
      code: 'non_clinical_words',
      weight: -Math.min(0.45, 0.14 * unknown.length),
      detail: `${unknown.length} word(s) outside the clinical vocabulary`,
    });
  }

  if (signals.acoustic !== null && signals.acoustic < 0.5) {
    reasons.push({
      code: 'low_confidence_audio',
      weight: -0.25,
      detail: `mean word confidence ${signals.acoustic.toFixed(2)}`,
    });
  }

  if (content.length > 12 && anchors.length === 0) {
    reasons.push({ code: 'long_non_clinical', weight: -0.3, detail: 'long utterance with no clinical anchor' });
  }

  const score = clamp(reasons.reduce((total, reason) => total + reason.weight, 0));
  const label: RelevanceLabel =
    score >= CHARTABLE_THRESHOLD
      ? 'chartable'
      : score <= NON_CHARTABLE_THRESHOLD
        ? 'non_chartable'
        : 'uncertain';
  return { label, score: round(score), reasons };
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Human-readable summary of why an utterance was or was not charted. */
export function explainRelevance(decision: RelevanceDecision): string {
  if (decision.reasons.length === 0) return 'no relevance evidence';
  return decision.reasons
    .map((reason) => `${reason.detail} (${reason.weight > 0 ? '+' : ''}${reason.weight.toFixed(2)})`)
    .join('; ');
}
