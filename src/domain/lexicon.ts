/**
 * Versioned dental lexicon.
 *
 * Two problems are solved here. General-purpose recognizers substitute common
 * English for uncommon clinical vocabulary ("buckle" for buccal, "vacation" for
 * furcation), and clinicians use abbreviations that never appear in a
 * conversational language model ("BOP", "PD", "MB"). Both are rewritten to a
 * small set of canonical tokens that the grammar below understands.
 *
 * Variants are split by risk. A `safe` variant is a word that is already
 * clinical or is not plausible conversational English, so it is always applied.
 * A `contextual` variant is an ordinary English word that happens to be a
 * frequent recognizer substitution; applying it unconditionally would invent
 * clinical meaning inside casual speech, so it is applied only once the
 * utterance has been judged clinically relevant.
 *
 * Bumping the lexicon changes chart output, so `LEXICON_VERSION` travels with
 * evaluation reports and telemetry.
 */

import { normalizeText } from './text';

export const LEXICON_VERSION = '2026.09.1';

export type LexiconCategory =
  | 'finding'
  | 'measurement'
  | 'surface'
  | 'site'
  | 'region'
  | 'anatomy'
  | 'command'
  | 'modifier'
  | 'filler';

export type VariantRisk = 'safe' | 'contextual';

export interface LexiconEntry {
  canonical: string;
  category: LexiconCategory;
  /** Always rewritten. Already-canonical spellings are included for identity. */
  safe: readonly string[];
  /** Rewritten only inside an utterance already judged clinically relevant. */
  contextual?: readonly string[];
  /** Included in the recognizer's biasing prompt. */
  prompt?: boolean;
  /** Natural spoken form used in the prompt; defaults to the canonical token. */
  promptText?: string;
}

export const LEXICON: readonly LexiconEntry[] = [
  /* ---------------- findings ---------------- */
  {
    canonical: 'bleeding',
    category: 'finding',
    prompt: true,
    promptText: 'bleeding on probing',
    safe: [
      'bleeding',
      'bleeding on probing',
      'bleeding upon probing',
      'bleeds on probing',
      'bleeding on probe',
      'bleeding point',
      'bleeds',
      'bleed',
      'b o p',
      'bop',
      'haemorrhage',
      'hemorrhage',
    ],
    contextual: ['breeding', 'pleading', 'bleeping', 'beating', 'leading'],
  },
  {
    canonical: 'suppuration',
    category: 'finding',
    prompt: true,
    promptText: 'suppuration',
    safe: [
      'suppuration',
      'suppurative',
      'supperation',
      'sup oration',
      'super ration',
      'purulence',
      'purulent',
      'exudate',
      'pus',
    ],
    contextual: ['separation', 'preparation', 'operation', 'supper ration'],
  },
  {
    canonical: 'plaque',
    category: 'finding',
    prompt: true,
    promptText: 'plaque',
    safe: ['plaque', 'plaques', 'biofilm', 'plack', 'plaq', 'soft deposits'],
    contextual: ['black', 'block', 'plack'],
  },
  {
    canonical: 'calculus',
    category: 'finding',
    prompt: true,
    promptText: 'calculus',
    safe: [
      'calculus',
      'calculous',
      'tartar',
      'sub gingival calculus',
      'subgingival calculus',
      'hard deposits',
    ],
    contextual: ['calculator', 'calcium', 'calc'],
  },
  {
    canonical: 'mobility',
    category: 'finding',
    prompt: true,
    promptText: 'mobility grade',
    safe: ['mobility', 'tooth mobility', 'mobile', 'miller class'],
    contextual: ['nobility', 'ability', 'mobility of'],
  },
  {
    canonical: 'furcation',
    category: 'finding',
    prompt: true,
    promptText: 'furcation involvement',
    safe: [
      'furcation',
      'furcations',
      'furcation involvement',
      'fur cation',
      'furcation involved',
    ],
    contextual: ['vacation', 'for cation', 'fabrication', 'publication', 'percussion'],
  },

  /* ---------------- measurements ---------------- */
  {
    canonical: 'depth',
    category: 'measurement',
    prompt: true,
    promptText: 'probing depth',
    safe: [
      'depth',
      'depths',
      'probing depth',
      'probing depths',
      'pocket depth',
      'pocket depths',
      'perio depth',
      'probe depth',
      'probing',
      'p d',
      'pd',
    ],
  },
  {
    canonical: 'recession',
    category: 'measurement',
    prompt: true,
    promptText: 'gingival recession',
    safe: [
      'recession',
      'recessions',
      'gingival recession',
      'gingival margin',
      'margin recession',
      'g m',
    ],
    contextual: ['procession', 'succession', 'session', 'reception'],
  },
  {
    canonical: 'attachment',
    category: 'measurement',
    prompt: true,
    promptText: 'clinical attachment level',
    safe: [
      'attachment',
      'attachment level',
      'clinical attachment level',
      'attachment loss',
      'c a l',
    ],
  },

  /* ---------------- surfaces and sites ---------------- */
  {
    canonical: 'buccal',
    category: 'surface',
    prompt: true,
    promptText: 'buccal',
    safe: ['buccal', 'facial', 'labial', 'vestibular', 'buccle', 'buckal', 'bucal', 'bucco'],
    contextual: ['buckle', 'book all', 'buckled', 'bugle'],
  },
  {
    canonical: 'lingual',
    category: 'surface',
    prompt: true,
    promptText: 'lingual',
    safe: ['lingual', 'palatal', 'palatine', 'lingal', 'linqual', 'lingular'],
    contextual: ['lingo', 'lingle', 'single', 'lingua'],
  },
  {
    canonical: 'site-mb',
    category: 'site',
    safe: ['mesial buccal', 'mesiobuccal', 'mesio buccal', 'm b'],
  },
  {
    canonical: 'site-b',
    category: 'site',
    safe: ['mid buccal', 'midbuccal', 'direct buccal', 'straight buccal'],
  },
  {
    canonical: 'site-db',
    category: 'site',
    safe: ['distal buccal', 'distobuccal', 'disto buccal', 'd b'],
  },
  {
    canonical: 'site-ml',
    category: 'site',
    safe: ['mesial lingual', 'mesiolingual', 'mesio lingual', 'm l'],
  },
  {
    canonical: 'site-l',
    category: 'site',
    safe: ['mid lingual', 'midlingual', 'direct lingual', 'straight lingual'],
  },
  {
    canonical: 'site-dl',
    category: 'site',
    safe: ['distal lingual', 'distolingual', 'disto lingual', 'd l'],
  },
  {
    canonical: 'mesial',
    category: 'site',
    safe: ['mesial', 'meezial', 'mezial'],
    contextual: ['medial', 'missile'],
  },
  {
    canonical: 'distal',
    category: 'site',
    safe: ['distal', 'dis tal'],
    contextual: ['dismal', 'crystal'],
  },

  /* ---------------- regions ---------------- */
  {
    canonical: 'quadrant-ur',
    category: 'region',
    safe: ['upper right', 'maxillary right', 'upper right quadrant'],
  },
  {
    canonical: 'quadrant-ul',
    category: 'region',
    safe: ['upper left', 'maxillary left', 'upper left quadrant'],
  },
  {
    canonical: 'quadrant-ll',
    category: 'region',
    safe: ['lower left', 'mandibular left', 'lower left quadrant'],
  },
  {
    canonical: 'quadrant-lr',
    category: 'region',
    safe: ['lower right', 'mandibular right', 'lower right quadrant'],
  },

  /* ---------------- anatomy ---------------- */
  {
    canonical: 'tooth',
    category: 'anatomy',
    prompt: true,
    promptText: 'tooth',
    safe: ['tooth', 'teeth', 'tooth number', 'tooth no'],
    contextual: ['truth', 'booth', 'toothe'],
  },
  {
    canonical: 'grade',
    category: 'modifier',
    safe: ['grade', 'class', 'degree'],
  },
  {
    canonical: 'millimeters',
    category: 'modifier',
    prompt: true,
    promptText: 'millimeters',
    safe: ['millimeters', 'millimetres', 'millimeter', 'millimetre', 'm m', 'mil'],
  },

  /* ---------------- workflow commands ---------------- */
  {
    canonical: 'skip',
    category: 'command',
    safe: [
      'skip',
      'skip this tooth',
      'skip that tooth',
      'skip tooth',
      'edentulous',
      'tooth is missing',
      'tooth missing',
    ],
    contextual: ['missing', 'extracted'],
  },
  {
    canonical: 'back',
    category: 'command',
    safe: ['go back', 'back up', 'previous tooth', 'step back', 'one back'],
    contextual: ['back', 'previous'],
  },
  {
    canonical: 'next',
    category: 'command',
    safe: ['next tooth', 'move on', 'next site', 'go on to the next', 'next one'],
    contextual: ['next', 'advance', 'onwards'],
  },
  {
    canonical: 'resume',
    category: 'command',
    safe: ['resume', 'resume charting', 'where was i', 'back to where i was', 'pick up where'],
    contextual: ['continue', 'carry on'],
  },
  {
    canonical: 'undo',
    category: 'command',
    safe: [
      'undo',
      'undo that',
      'scratch that',
      'strike that',
      'take that back',
      'disregard that',
      'delete that',
      'remove that',
    ],
  },
  {
    canonical: 'redo',
    category: 'command',
    safe: ['redo', 'redo that', 'put that back', 'restore that'],
  },
  {
    canonical: 'repeat',
    category: 'command',
    safe: [
      'repeat that',
      'repeat the sequence',
      'repeat sequence',
      'start over',
      'let me redo that sequence',
      'do that again',
      'read back',
    ],
    contextual: ['repeat'],
  },
  {
    canonical: 'correct',
    category: 'command',
    safe: [
      'correct that to',
      'correct that',
      'change that to',
      'change it to',
      'make that',
      'make it',
      'i meant',
      'correction',
    ],
    contextual: ['correct'],
  },
  {
    canonical: 'confirm',
    category: 'command',
    safe: ['confirm', 'confirmed', 'that is right', "that's right", 'yes confirm'],
  },
  {
    canonical: 'clear',
    category: 'command',
    safe: ['clear that', 'clear this tooth', 'clear the tooth', 'reset this tooth'],
  },
];

export interface LexiconReplacement {
  from: string;
  to: string;
  index: number;
  risk: VariantRisk;
}

export interface CanonicalizeResult {
  tokens: string[];
  replacements: LexiconReplacement[];
}

interface CompiledVariant {
  phrase: string;
  canonical: string;
  risk: VariantRisk;
  length: number;
}

function compile(): { table: Map<string, CompiledVariant>; maxLength: number } {
  const table = new Map<string, CompiledVariant>();
  let maxLength = 1;
  const add = (phrase: string, canonical: string, risk: VariantRisk): void => {
    const normalized = normalizeText(phrase);
    if (normalized === '') return;
    const length = normalized.split(' ').length;
    const existing = table.get(normalized);
    // A safe mapping always wins over a contextual mapping of the same phrase.
    if (existing && (existing.risk === 'safe' || risk === 'contextual')) return;
    table.set(normalized, { phrase: normalized, canonical, risk, length });
    if (length > maxLength) maxLength = length;
  };
  for (const entry of LEXICON) {
    add(entry.canonical, entry.canonical, 'safe');
    for (const variant of entry.safe) add(variant, entry.canonical, 'safe');
    for (const variant of entry.contextual ?? []) add(variant, entry.canonical, 'contextual');
  }
  return { table, maxLength };
}

const { table: VARIANTS, maxLength: MAX_PHRASE_LENGTH } = compile();

const CATEGORIES = new Map<string, LexiconCategory>(
  LEXICON.map((entry) => [entry.canonical, entry.category]),
);

export interface CanonicalizeOptions {
  /** Enables contextual variants. Only pass true for clinically relevant speech. */
  contextual?: boolean;
}

/** Rewrites a token stream to canonical clinical vocabulary, longest match first. */
export function canonicalizeTokens(
  tokens: readonly string[],
  options: CanonicalizeOptions = {},
): CanonicalizeResult {
  const allowContextual = options.contextual === true;
  const output: string[] = [];
  const replacements: LexiconReplacement[] = [];
  let index = 0;
  while (index < tokens.length) {
    const remaining = tokens.length - index;
    let matched: CompiledVariant | null = null;
    for (let span = Math.min(MAX_PHRASE_LENGTH, remaining); span >= 1; span -= 1) {
      const phrase = tokens.slice(index, index + span).join(' ');
      const candidate = VARIANTS.get(phrase);
      if (!candidate) continue;
      if (candidate.risk === 'contextual' && !allowContextual) continue;
      matched = candidate;
      break;
    }
    if (!matched) {
      output.push(tokens[index]);
      index += 1;
      continue;
    }
    if (matched.phrase !== matched.canonical) {
      replacements.push({
        from: matched.phrase,
        to: matched.canonical,
        index: output.length,
        risk: matched.risk,
      });
    }
    output.push(matched.canonical);
    index += matched.length;
  }
  return { tokens: output, replacements };
}

export function canonicalize(text: string, options: CanonicalizeOptions = {}): CanonicalizeResult {
  const normalized = normalizeText(text);
  const tokens = normalized === '' ? [] : normalized.split(' ');
  return canonicalizeTokens(tokens, options);
}

export function categoryOf(token: string): LexiconCategory | null {
  return CATEGORIES.get(token) ?? null;
}

export function isCanonicalTerm(token: string): boolean {
  return CATEGORIES.has(token);
}

/** Every canonical token, for coverage checks and telemetry label bounds. */
export function canonicalTerms(): string[] {
  return LEXICON.map((entry) => entry.canonical);
}

export function variantCount(): number {
  return VARIANTS.size;
}

/**
 * Biasing prompt handed to the recognizer. Whisper conditions its decoder on
 * this text, which pulls rare clinical vocabulary above the common English word
 * it would otherwise emit.
 */
export function dentalPrompt(): string {
  const terms = LEXICON.filter((entry) => entry.prompt === true).map(
    (entry) => entry.promptText ?? entry.canonical,
  );
  return (
    `Periodontal charting: ${terms.join(', ')}, mesial, distal. `
    + 'Depths are single digits one through twelve; tooth numbers run one through thirty-two.'
  );
}
