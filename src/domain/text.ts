/** Shared, allocation-light text normalization for the clinical pipeline. */

const DASHES = /[‐-―−]/g;
const APOSTROPHES = /[‘’ʼ]/g;

/**
 * Lower-cases, folds punctuation to spaces and collapses whitespace while
 * preserving the hyphen, which carries meaning in compound number words such as
 * "twenty-eight".
 */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(DASHES, '-')
    .replace(APOSTROPHES, "'")
    .replace(/[^a-z0-9\s'-]/g, ' ')
    // Large recognizers fuse letters and digits: "p d three four five" came back
    // as "pd345", one token that is neither a word nor a number. Splitting at the
    // boundary lets the lexicon read "pd" and the lattice read the digits.
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized === '' ? [] : normalized.split(' ');
}

/** Removes a trailing possessive or plural "s" only for exact lexicon lookups. */
export function singularize(token: string): string {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

export function titleCase(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}
