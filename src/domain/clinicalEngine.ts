import type {
  ClinicalContext,
  ClinicalEvent,
  ClinicalEventKind,
  ClinicalSession,
  ContextPatch,
  PerioRecord,
  Surface,
  TranscriptTiming,
} from './types';

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'twenty-one',
  'twenty-two',
  'twenty-three',
  'twenty-four',
  'twenty-five',
  'twenty-six',
  'twenty-seven',
  'twenty-eight',
  'twenty-nine',
  'thirty',
  'thirty-one',
  'thirty-two',
] as const;

const WORD_TO_NUMBER = new Map<string, number>(
  NUMBER_WORDS.flatMap((word, value) => {
    const entries: Array<[string, number]> = [[word, value]];
    if (word.includes('-')) entries.push([word.replace('-', ' '), value]);
    return entries;
  }),
);

// Short utterances are often returned by ASR as homophones. Interpret these
// numerically only after the whole phrase passes the charting filter below.
WORD_TO_NUMBER.set('to', 2);
WORD_TO_NUMBER.set('too', 2);
WORD_TO_NUMBER.set('for', 4);
WORD_TO_NUMBER.set('ate', 8);

const CORRECTION_MARKER = /\b(?:no|sorry|actually|correction|correct that(?: to)?|make that)\b/i;
const REPEAT_MARKER = /\brepeat(?:\s+(?:that|sequence))?\b/i;
const NUMERIC_FILLERS = new Set([
  'and',
  'then',
  'okay',
  'ok',
  'uh',
  'um',
  'depth',
  'depths',
  'probing',
  'probe',
  'value',
  'values',
  'bleeding',
]);

export function chartKey(tooth: number, surface: Surface): string {
  return `${tooth}-${surface}`;
}

export function emptyRecord(tooth: number, surface: Surface): PerioRecord {
  return {
    tooth,
    surface,
    probingDepths: [null, null, null],
    bleeding: null,
    updatedAt: null,
  };
}

export function createInitialSession(): ClinicalSession {
  const context: ClinicalContext = {
    tooth: 14,
    surface: 'buccal',
    measurement: 'probing_depth',
    expectedValues: 3,
    position: 0,
  };
  const key = chartKey(context.tooth, context.surface);
  return {
    context,
    charts: { [key]: emptyRecord(context.tooth, context.surface) },
    history: [],
    latencySamples: [],
    nextEventId: 1,
  };
}

export function currentRecord(session: ClinicalSession): PerioRecord {
  const { tooth, surface } = session.context;
  return session.charts[chartKey(tooth, surface)] ?? emptyRecord(tooth, surface);
}

function normalizeTranscript(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractNumbers(text: string): number[] {
  let normalized = normalizeTranscript(text);
  for (let value = 32; value >= 0; value -= 1) {
    const word = NUMBER_WORDS[value];
    if (word.includes('-')) {
      normalized = normalized.replaceAll(word.replace('-', ' '), word);
    }
  }

  return normalized
    .split(' ')
    .map((token) => {
      if (/^\d+$/.test(token)) return Number(token);
      return WORD_TO_NUMBER.get(token);
    })
    .filter((value): value is number => value !== undefined);
}

function isChartingNumberPhrase(text: string): boolean {
  let normalized = normalizeTranscript(text);
  for (let value = 32; value >= 20; value -= 1) {
    const word = NUMBER_WORDS[value];
    if (word.includes('-')) normalized = normalized.replaceAll(word.replace('-', ' '), word);
  }

  const tokens = normalized.split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => {
    return /^\d+$/.test(token) || WORD_TO_NUMBER.has(token) || NUMERIC_FILLERS.has(token);
  });
}

function calculateLatency(timing: TranscriptTiming): number {
  return Math.max(0, Math.round(timing.observedAt - timing.startedAt));
}

function withEvent(
  session: ClinicalSession,
  kind: ClinicalEventKind,
  transcript: string,
  message: string,
  occurredAt: number,
  latencyMs: number | null,
): ClinicalSession {
  const event: ClinicalEvent = {
    id: session.nextEventId,
    kind,
    transcript,
    message,
    occurredAt,
    latencyMs,
  };
  return {
    ...session,
    history: [event, ...session.history].slice(0, 100),
    latencySamples:
      latencyMs === null
        ? session.latencySamples
        : [...session.latencySamples, latencyMs].slice(-200),
    nextEventId: session.nextEventId + 1,
  };
}

function nextOpenPosition(record: PerioRecord): number {
  const index = record.probingDepths.findIndex((value) => value === null);
  return index === -1 ? 3 : index;
}

export function updateContext(
  session: ClinicalSession,
  patch: ContextPatch,
  occurredAt: number,
  transcript = 'Context control',
): ClinicalSession {
  const tooth = patch.tooth ?? session.context.tooth;
  const surface = patch.surface ?? session.context.surface;
  if (!Number.isInteger(tooth) || tooth < 1 || tooth > 32) {
    return withEvent(
      session,
      'rejected',
      transcript,
      'Tooth number must be between 1 and 32.',
      occurredAt,
      null,
    );
  }

  const key = chartKey(tooth, surface);
  const charts = session.charts[key]
    ? session.charts
    : { ...session.charts, [key]: emptyRecord(tooth, surface) };
  const record = charts[key];
  const next: ClinicalSession = {
    ...session,
    charts,
    context: {
      ...session.context,
      tooth,
      surface,
      position: nextOpenPosition(record),
    },
  };
  return withEvent(
    next,
    'context',
    transcript,
    `Context moved to tooth ${tooth}, ${surface}.`,
    occurredAt,
    null,
  );
}

function updateCurrentRecord(
  session: ClinicalSession,
  record: PerioRecord,
  position: number,
): ClinicalSession {
  const key = chartKey(record.tooth, record.surface);
  return {
    ...session,
    charts: { ...session.charts, [key]: record },
    context: { ...session.context, position },
  };
}

function applyCorrection(
  session: ClinicalSession,
  transcript: string,
  replacement: number,
  timing: TranscriptTiming,
): ClinicalSession {
  const record = currentRecord(session);
  let lastFilledIndex = -1;
  record.probingDepths.forEach((value, index) => {
    if (value !== null) lastFilledIndex = index;
  });
  if (lastFilledIndex === -1) {
    return withEvent(
      session,
      'rejected',
      transcript,
      'There is no probing depth to correct in the active context.',
      timing.observedAt,
      null,
    );
  }
  if (replacement < 1 || replacement > 12) {
    return withEvent(
      session,
      'rejected',
      transcript,
      'Probing depths must be between 1 and 12 millimeters.',
      timing.observedAt,
      null,
    );
  }

  const previous = record.probingDepths[lastFilledIndex];
  const depths: PerioRecord['probingDepths'] = [...record.probingDepths];
  depths[lastFilledIndex] = replacement;
  const updated = { ...record, probingDepths: depths, updatedAt: timing.observedAt };
  const next = updateCurrentRecord(session, updated, nextOpenPosition(updated));
  return withEvent(
    next,
    'correction',
    transcript,
    `Corrected site ${lastFilledIndex + 1} from ${previous} to ${replacement} mm.`,
    timing.observedAt,
    calculateLatency(timing),
  );
}

function replaceSequence(
  session: ClinicalSession,
  transcript: string,
  values: number[],
  timing: TranscriptTiming,
): ClinicalSession {
  if (values.length !== 3 || values.some((value) => value < 1 || value > 12)) {
    return withEvent(
      session,
      'rejected',
      transcript,
      'A replacement sequence must contain exactly three depths from 1 to 12 mm.',
      timing.observedAt,
      null,
    );
  }
  const record = currentRecord(session);
  const updated: PerioRecord = {
    ...record,
    probingDepths: [values[0], values[1], values[2]],
    updatedAt: timing.observedAt,
  };
  const next = updateCurrentRecord(session, updated, 3);
  return withEvent(
    next,
    'sequence_replacement',
    transcript,
    `Replaced the active sequence with ${values.join(' / ')} mm.`,
    timing.observedAt,
    calculateLatency(timing),
  );
}

function applyBleeding(
  session: ClinicalSession,
  transcript: string,
  value: boolean,
  timing: TranscriptTiming,
): ClinicalSession {
  const record = currentRecord(session);
  const updated = { ...record, bleeding: value, updatedAt: timing.observedAt };
  const next = updateCurrentRecord(session, updated, session.context.position);
  return withEvent(
    next,
    'bleeding',
    transcript,
    `Bleeding set to ${value ? 'yes' : 'no'}.`,
    timing.observedAt,
    calculateLatency(timing),
  );
}

function appendDepths(
  session: ClinicalSession,
  transcript: string,
  values: number[],
  timing: TranscriptTiming,
): ClinicalSession {
  if (values.length === 0) return session;
  if (values.some((value) => value < 1 || value > 12)) {
    return withEvent(
      session,
      'rejected',
      transcript,
      'Probing depths must be between 1 and 12 millimeters.',
      timing.observedAt,
      null,
    );
  }

  const record = currentRecord(session);
  const position = nextOpenPosition(record);
  const remaining = 3 - position;
  if (position >= 3) {
    return withEvent(
      session,
      'rejected',
      transcript,
      'The active three-site sequence is complete. Change context or say “repeat that” with three values.',
      timing.observedAt,
      null,
    );
  }
  if (values.length > remaining) {
    return withEvent(
      session,
      'rejected',
      transcript,
      `Expected ${remaining} more ${remaining === 1 ? 'value' : 'values'}; no depths were changed.`,
      timing.observedAt,
      null,
    );
  }

  const depths: PerioRecord['probingDepths'] = [...record.probingDepths];
  values.forEach((value, offset) => {
    depths[position + offset] = value;
  });
  const updated = { ...record, probingDepths: depths, updatedAt: timing.observedAt };
  const nextPosition = nextOpenPosition(updated);
  const next = updateCurrentRecord(session, updated, nextPosition);
  return withEvent(
    next,
    'depth_sequence',
    transcript,
    `Recorded ${values.join(' / ')} mm at position${values.length > 1 ? 's' : ''} ${position + 1}${
      values.length > 1 ? `–${position + values.length}` : ''
    }.`,
    timing.observedAt,
    calculateLatency(timing),
  );
}

function parseSpokenContext(normalized: string): ContextPatch | null {
  const mentionsTooth = /\btooth\b/.test(normalized);
  const surface: Surface | undefined = /\blingual\b/.test(normalized)
    ? 'lingual'
    : /\bbuccal\b/.test(normalized)
      ? 'buccal'
      : undefined;
  if (!mentionsTooth && !surface) return null;

  const numbers = mentionsTooth ? extractNumbers(normalized) : [];
  const tooth = numbers.length > 0 ? numbers[numbers.length - 1] : undefined;
  return { tooth, surface };
}

export function applyTranscript(
  session: ClinicalSession,
  transcript: string,
  timing: TranscriptTiming,
): ClinicalSession {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) {
    return withEvent(
      session,
      'ignored',
      transcript,
      'Empty transcript ignored.',
      timing.observedAt,
      null,
    );
  }

  const contextPatch = parseSpokenContext(normalized);
  if (contextPatch) {
    if (contextPatch.tooth === undefined && /\btooth\b/.test(normalized)) {
      return withEvent(
        session,
        'rejected',
        transcript,
        'A tooth command needs a tooth number from 1 to 32.',
        timing.observedAt,
        null,
      );
    }
    return updateContext(session, contextPatch, timing.observedAt, transcript);
  }

  const repeatMatch = normalized.match(REPEAT_MARKER);
  if (repeatMatch?.index !== undefined) {
    const replacementText = normalized.slice(repeatMatch.index + repeatMatch[0].length);
    return replaceSequence(session, transcript, extractNumbers(replacementText), timing);
  }

  if (!/\bno bleeding\b/.test(normalized) && CORRECTION_MARKER.test(normalized)) {
    const match = normalized.match(CORRECTION_MARKER);
    const replacementText = match?.index === undefined
      ? ''
      : normalized.slice(match.index + match[0].length);
    const replacements = extractNumbers(replacementText);
    if (replacements.length === 1) {
      return applyCorrection(session, transcript, replacements[0], timing);
    }
    return withEvent(
      session,
      'rejected',
      transcript,
      'A correction must end with one replacement probing depth.',
      timing.observedAt,
      null,
    );
  }

  let next = session;
  const containsBleeding = /\bbleeding\b/.test(normalized);
  const numberText = normalized.replace(/\b(?:no\s+)?bleeding\b/g, ' ').trim();
  const values = extractNumbers(numberText);

  if (values.length > 0) {
    if (!isChartingNumberPhrase(numberText)) {
      return withEvent(
        session,
        'ignored',
        transcript,
        'Speech contained non-charting language, so no clinical values were changed.',
        timing.observedAt,
        null,
      );
    }
    next = appendDepths(next, transcript, values, timing);
    if (next.history[0]?.kind === 'rejected') return next;
  }

  if (containsBleeding) {
    next = applyBleeding(next, transcript, !/\b(?:no|without)\s+bleeding\b/.test(normalized), timing);
  }

  if (values.length === 0 && !containsBleeding) {
    return withEvent(
      session,
      'ignored',
      transcript,
      'No chartable periodontal command was detected.',
      timing.observedAt,
      null,
    );
  }
  return next;
}

export function latencySummary(samples: number[]): {
  latest: number | null;
  average: number | null;
  p95: number | null;
} {
  if (samples.length === 0) return { latest: null, average: null, p95: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const average = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    latest: samples[samples.length - 1],
    average,
    p95: sorted[p95Index],
  };
}

export function clearCurrentRecord(
  session: ClinicalSession,
  occurredAt: number,
): ClinicalSession {
  const { tooth, surface } = session.context;
  const record = emptyRecord(tooth, surface);
  const next = updateCurrentRecord(session, record, 0);
  return withEvent(
    next,
    'context',
    'Clear active record',
    `Cleared tooth ${tooth}, ${surface}.`,
    occurredAt,
    null,
  );
}
