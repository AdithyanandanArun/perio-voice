/**
 * Intent grammar.
 *
 * Turns resolved tokens into typed clinical intents. The grammar is
 * conservative by design: it recognizes the constructions clinicians actually
 * use while charting and declines everything else, so an unrecognized sentence
 * becomes a visible "no intent" rather than a guess at a measurement.
 *
 * One utterance can carry several intents — "tooth fifteen three four five
 * bleeding" moves context, records depths and asserts a finding — and they are
 * emitted in the order they must be applied.
 */

import { resolveAssertions, type FindingAssertion } from './negation';
import { QUADRANT_RANGES, type Quadrant } from './workflow';
import type { ResolvedToken } from './contextResolver';
import type { ClinicalContext, MeasurementType, Surface } from './types';

export type WorkflowCommand =
  | 'next'
  | 'back'
  | 'skip'
  | 'resume'
  | 'undo'
  | 'redo'
  | 'clear'
  | 'confirm';

export interface CorrectionTarget {
  scope: 'last' | 'site';
  siteIndex: number | null;
}

export type Intent =
  | { kind: 'command'; command: WorkflowCommand; tooth: number | null }
  | {
      kind: 'context';
      tooth: number | null;
      surface: Surface | null;
      measurement: MeasurementType | null;
    }
  | { kind: 'replace_sequence'; measurement: MeasurementType; values: number[] }
  | { kind: 'correction'; measurement: MeasurementType; target: CorrectionTarget; value: number }
  | {
      kind: 'measurements';
      measurement: MeasurementType;
      values: number[];
      siteIndex: number | null;
    }
  | { kind: 'findings'; assertions: FindingAssertion[] };

export interface ParseResult {
  intents: Intent[];
  measurement: MeasurementType;
  /** Tokens no intent claimed, which the pipeline reports as unparsed speech. */
  leftover: string[];
}

const COMMAND_TERMS: Readonly<Record<string, WorkflowCommand>> = {
  next: 'next',
  back: 'back',
  skip: 'skip',
  resume: 'resume',
  undo: 'undo',
  redo: 'redo',
  clear: 'clear',
  confirm: 'confirm',
};

const CORRECTION_CUES = new Set([
  'no',
  'sorry',
  'actually',
  'correct',
  'instead',
  'rather',
  'meant',
]);

const SITE_TERMS: Readonly<Record<string, { surface: Surface; index: number }>> = {
  'site-mb': { surface: 'buccal', index: 0 },
  'site-b': { surface: 'buccal', index: 1 },
  'site-db': { surface: 'buccal', index: 2 },
  'site-ml': { surface: 'lingual', index: 0 },
  'site-l': { surface: 'lingual', index: 1 },
  'site-dl': { surface: 'lingual', index: 2 },
};

const QUADRANT_TERMS: Readonly<Record<string, Quadrant>> = {
  'quadrant-ur': 'UR',
  'quadrant-ul': 'UL',
  'quadrant-ll': 'LL',
  'quadrant-lr': 'LR',
};

function isTerm(token: ResolvedToken, term: string): boolean {
  return token.kind === 'term' && token.term === term;
}

function isNumber(token: ResolvedToken): token is ResolvedToken & { value: number } {
  return token.kind === 'number' && token.value !== null;
}

export function parseIntents(
  resolved: readonly ResolvedToken[],
  context: ClinicalContext,
): ParseResult {
  const negation = resolveAssertions(resolved);
  const consumed = new Set<number>(negation.consumed);
  const intents: Intent[] = [];

  const available = (index: number): boolean => !consumed.has(index);
  const findTerm = (term: string): number =>
    resolved.findIndex((token, index) => available(index) && isTerm(token, term));

  const measurement: MeasurementType = findTerm('recession') !== -1
    ? 'recession'
    : findTerm('depth') !== -1
      ? 'probing_depth'
      : context.measurement;
  for (const term of ['depth', 'recession', 'attachment', 'millimeters', 'grade']) {
    const index = findTerm(term);
    if (index !== -1) consumed.add(index);
  }

  /* -------- workflow commands are their own utterance -------- */
  for (const [term, command] of Object.entries(COMMAND_TERMS)) {
    const index = findTerm(term);
    if (index === -1) continue;
    consumed.add(index);
    const binding = bindTooth(resolved, findTerm('tooth'), consumed);
    return {
      intents: [{ kind: 'command', command, tooth: binding.tooth }],
      measurement,
      leftover: leftoverTokens(resolved, consumed),
    };
  }

  /* -------- explicit sequence replacement -------- */
  const repeatIndex = findTerm('repeat');
  if (repeatIndex !== -1) {
    consumed.add(repeatIndex);
    const values: number[] = [];
    for (let index = repeatIndex + 1; index < resolved.length; index += 1) {
      const token = resolved[index];
      if (!available(index)) continue;
      if (isNumber(token)) {
        values.push(token.value);
        consumed.add(index);
      }
    }
    return {
      intents: [{ kind: 'replace_sequence', measurement, values }],
      measurement,
      leftover: leftoverTokens(resolved, consumed),
    };
  }

  /* -------- anatomical context -------- */
  const toothIndex = findTerm('tooth');
  const quadrantIndex = resolved.findIndex(
    (token, index) => available(index) && token.kind === 'term' && token.term !== null && token.term in QUADRANT_TERMS,
  );
  let surface: Surface | null = null;
  for (const candidate of ['buccal', 'lingual'] as const) {
    const index = findTerm(candidate);
    if (index !== -1) {
      surface = candidate;
      consumed.add(index);
    }
  }

  let siteIndex: number | null = null;
  for (const [term, site] of Object.entries(SITE_TERMS)) {
    const index = findTerm(term);
    if (index === -1) continue;
    consumed.add(index);
    siteIndex = site.index;
    surface = surface ?? site.surface;
  }

  let tooth: number | null = null;
  if (toothIndex !== -1) {
    consumed.add(toothIndex);
    const binding = bindTooth(resolved, toothIndex, consumed);
    tooth = binding.tooth;
    for (const index of binding.used) consumed.add(index);
  } else if (quadrantIndex !== -1) {
    const term = resolved[quadrantIndex].term as string;
    consumed.add(quadrantIndex);
    tooth = QUADRANT_RANGES[QUADRANT_TERMS[term]][0];
  }

  if (tooth !== null || surface !== null) {
    intents.push({ kind: 'context', tooth, surface, measurement: null });
  }

  /* -------- spoken correction -------- */
  const cueIndex = resolved.findIndex(
    (token, index) =>
      available(index) && !negation.cues.has(index) && CORRECTION_CUES.has(token.token),
  );
  if (cueIndex !== -1) {
    const following: number[] = [];
    for (let index = cueIndex + 1; index < resolved.length; index += 1) {
      if (!available(index)) continue;
      const token = resolved[index];
      if (isNumber(token)) following.push(token.value);
    }
    if (following.length > 0) {
      // Everything before the cue was the misspoken attempt and is discarded.
      for (let index = 0; index < resolved.length; index += 1) consumed.add(index);
      if (following.length === 1) {
        intents.push({
          kind: 'correction',
          measurement,
          target: { scope: siteIndex === null ? 'last' : 'site', siteIndex },
          value: following[0],
        });
      } else {
        intents.push({ kind: 'replace_sequence', measurement, values: following });
      }
      if (negation.assertions.length > 0) {
        intents.push({ kind: 'findings', assertions: negation.assertions });
      }
      return { intents, measurement, leftover: leftoverTokens(resolved, consumed) };
    }
  }

  /* -------- remaining values -------- */
  const values: number[] = [];
  for (let index = 0; index < resolved.length; index += 1) {
    if (!available(index)) continue;
    const token = resolved[index];
    if (isNumber(token)) {
      values.push(token.value);
      consumed.add(index);
    }
  }
  if (values.length > 0) {
    intents.push({ kind: 'measurements', measurement, values, siteIndex });
  }

  if (negation.assertions.length > 0) {
    intents.push({ kind: 'findings', assertions: negation.assertions });
  }

  return { intents, measurement, leftover: leftoverTokens(resolved, consumed) };
}

/**
 * Binds the tooth number spoken after "tooth", following self-corrections:
 * "tooth fourteen, sorry, fifteen" binds fifteen.
 */
function bindTooth(
  resolved: readonly ResolvedToken[],
  toothIndex: number,
  consumed: ReadonlySet<number>,
): { tooth: number | null; used: number[] } {
  if (toothIndex === -1) return { tooth: null, used: [] };
  const used: number[] = [];
  let tooth: number | null = null;
  let index = toothIndex + 1;
  while (index < resolved.length) {
    const token = resolved[index];
    if (consumed.has(index)) {
      index += 1;
      continue;
    }
    if (isNumber(token)) {
      tooth = token.value;
      used.push(index);
      // A correction cue followed by another number overrides the binding.
      const cue = resolved[index + 1];
      const replacement = resolved[index + 2];
      if (
        cue !== undefined
        && CORRECTION_CUES.has(cue.token)
        && replacement !== undefined
        && isNumber(replacement)
      ) {
        used.push(index + 1);
        index += 1;
        continue;
      }
      break;
    }
    if (token.kind === 'term') break;
    index += 1;
  }
  return { tooth, used };
}

function leftoverTokens(resolved: readonly ResolvedToken[], consumed: ReadonlySet<number>): string[] {
  return resolved
    .filter((token, index) => !consumed.has(index) && token.kind === 'unknown')
    .map((token) => token.token);
}

export function describeIntent(intent: Intent): string {
  switch (intent.kind) {
    case 'command':
      return `command ${intent.command}${intent.tooth === null ? '' : ` tooth ${intent.tooth}`}`;
    case 'context':
      return `context${intent.tooth === null ? '' : ` tooth ${intent.tooth}`}${
        intent.surface === null ? '' : ` ${intent.surface}`
      }`;
    case 'replace_sequence':
      return `replace sequence ${intent.values.join('/')}`;
    case 'correction':
      return `correct ${intent.target.scope} to ${intent.value}`;
    case 'measurements':
      return `${intent.measurement} ${intent.values.join('/')}`;
    case 'findings':
      return `findings ${intent.assertions.map((assertion) => assertion.finding).join('/')}`;
  }
}
