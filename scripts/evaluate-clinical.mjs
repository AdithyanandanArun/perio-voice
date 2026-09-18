/**
 * Clinical evaluation harness.
 *
 * With no arguments this replays the checked-in text corpus exactly as before.
 * `--transcripts` instead validates a complete dental decoder report, replaces
 * each manifest prompt with the recognizer's actual transcript, and replays
 * every quiet/noise scenario through the same bundled production domain.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadDomain } from './lib/domain.mjs';

const CORPUS = 'evaluation/corpus/clinical.json';
const TRANSCRIPT_SCHEMA_VERSION = 1;

// The corpora were authored at tooth 14 buccal; this pins that instead of
// inheriting the product default. Most scenarios in evaluation/corpus/clinical.json
// and evaluation/fixtures/dental/phrases.json declare no explicit `start` and their
// expectations assume tooth 14 buccal (e.g. "tooth 14 buccal probingDepths"). The
// product's own new-exam default is the first station of the full-mouth sweep
// (src/domain/session.ts), which is intentionally a different tooth.
export const HARNESS_DEFAULT_START = { tooth: 14, surface: 'buccal' };

/** Acceptance thresholds. A change that crosses one of these has to be argued for. */
const THRESHOLDS = {
  exactMatch: 0.95,
  falseEntryRate: 0.02,
  alignmentErrors: 0,
  correctionSuccess: 1,
  contextSuccess: 1,
  parserP95Ms: 10,
};

const COMMITTING_KINDS = new Set([
  'depth_sequence',
  'recession_sequence',
  'bleeding',
  'finding',
  'correction',
  'sequence_replacement',
]);

function speakerVerdict(utterance) {
  if (!utterance.speaker && utterance.overridden !== true) return null;
  const decision = utterance.speaker ?? 'clinician';
  return {
    decision,
    similarity: decision === 'clinician' ? 0.99 : decision === 'other' ? 0.41 : 0.96,
    overridden: utterance.overridden === true,
  };
}

function buildInput(utterance, index) {
  const startedAt = index * 1_000;
  return {
    transcript: utterance.text,
    words: [],
    timing: { startedAt, observedAt: startedAt + 220 },
    source: 'evaluation',
    utteranceId: index + 1,
    audioMs: utterance.audioMs ?? 700,
    decodeMs: utterance.decodeMs ?? 180,
    noSpeechProbability: utterance.noSpeechProbability ?? null,
    averageLogProbability: utterance.averageLogProbability ?? null,
    observedVersion: utterance.observedVersion ?? null,
    speaker: speakerVerdict(utterance),
  };
}

function sameValue(actual, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((value, index) => (actual[index] ?? null) === (value ?? null))
    );
  }
  return (actual ?? null) === (expected ?? null);
}

function checkCase(domain, testCase, relevanceMode) {
  const failures = [];
  const settings = { ...(testCase.settings ?? {}) };
  // A scenario that pins its own relevanceMode is testing that mode
  // specifically (e.g. a shadow-mode regression case); the CLI flag applies
  // to every other scenario.
  if (relevanceMode && settings.relevanceMode === undefined) {
    settings.relevanceMode = relevanceMode;
  }
  let session = domain.createInitialSession(settings);
  if (testCase.start) {
    // An explicit start is a scenario testing navigation: replay it as a real
    // jump from the product's own starting station, exactly as before.
    session = domain.updateContext(session, testCase.start, -1);
  } else {
    // No explicit start: the scenario was authored assuming it began there
    // natively, not that the clinician navigated there. Set it directly so no
    // jump artifact (resumeStack entry, manual mode) leaks into the replay.
    const tooth = HARNESS_DEFAULT_START.tooth;
    const surface = HARNESS_DEFAULT_START.surface;
    session = {
      ...session,
      context: { ...session.context, tooth, surface },
      workflow: { stationIndex: domain.stationIndexOf(tooth, surface), mode: 'sequential', skipped: [], resumeStack: [] },
    };
  }

  let falseEntries = 0;
  testCase.utterances.forEach((utterance, index) => {
    const before = session.journal.length;
    session = domain.processUtterance(session, buildInput(utterance, index));
    const entry = session.journal.at(-1);
    const wrote = session.journal.length > before && (entry?.changes.length ?? 0) > 0;
    const committed = wrote && COMMITTING_KINDS.has(session.history[0]?.kind);
    if (utterance.chartable === false && committed) {
      falseEntries += 1;
      failures.push(`"${utterance.text}" committed ${session.history[0].message}`);
    }
  });

  const expected = testCase.expect ?? {};
  let alignmentErrors = 0;

  for (const want of expected.records ?? []) {
    const actual = domain.recordAt(session.charts, want.tooth, want.surface);
    for (const [field, value] of Object.entries(want)) {
      if (field === 'tooth' || field === 'surface') continue;
      if (!sameValue(actual[field], value)) {
        failures.push(
          `tooth ${want.tooth} ${want.surface} ${field}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[field])}`,
        );
      }
      if (field === 'probingDepths' || field === 'recession') {
        alignmentErrors += domain.alignmentError(actual[field], value);
      }
    }
  }

  for (const want of expected.teeth ?? []) {
    const actual = domain.toothAt(session.teeth, want.tooth);
    for (const [field, value] of Object.entries(want)) {
      if (field === 'tooth') continue;
      if (!sameValue(actual[field], value)) {
        failures.push(`tooth ${want.tooth} ${field}: expected ${value}, got ${actual[field]}`);
      }
    }
  }

  for (const [field, value] of Object.entries(expected.context ?? {})) {
    if (!sameValue(session.context[field], value)) {
      failures.push(`context ${field}: expected ${value}, got ${session.context[field]}`);
    }
  }

  if (expected.pending !== undefined && session.pending.length !== expected.pending) {
    failures.push(`pending confirmations: expected ${expected.pending}, got ${session.pending.length}`);
  }

  if (expected.skipped !== undefined && !sameValue(session.workflow.skipped, expected.skipped)) {
    failures.push(`skipped teeth: expected ${JSON.stringify(expected.skipped)}, got ${JSON.stringify(session.workflow.skipped)}`);
  }

  if (expected.rejections !== undefined) {
    const rejections = session.history.filter((event) => event.kind === 'rejected').length;
    if (rejections !== expected.rejections) {
      failures.push(`rejections: expected ${expected.rejections}, got ${rejections}`);
    }
  }

  return {
    id: testCase.id,
    pass: testCase.pass ?? null,
    cohort: testCase.cohort,
    passed: failures.length === 0,
    failures,
    falseEntries,
    alignmentErrors,
    nonChartable: testCase.utterances.filter((item) => item.chartable === false).length,
    parserSamples: session.parserSamples,
  };
}

function percentile(samples, fraction) {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function cohortTable(results) {
  const cohorts = new Map();
  for (const result of results) {
    const row = cohorts.get(result.cohort) ?? { total: 0, passed: 0, falseEntries: 0 };
    row.total += 1;
    row.passed += result.passed ? 1 : 0;
    row.falseEntries += result.falseEntries;
    cohorts.set(result.cohort, row);
  }
  return [...cohorts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function evaluateCases(domain, cases, relevanceMode = null) {
  const results = cases.map((testCase) => checkCase(domain, testCase, relevanceMode));
  const parserSamples = results.flatMap((result) => result.parserSamples);
  const nonChartable = results.reduce((sum, result) => sum + result.nonChartable, 0);
  const falseEntries = results.reduce((sum, result) => sum + result.falseEntries, 0);
  const alignmentErrors = results.reduce((sum, result) => sum + result.alignmentErrors, 0);
  const passed = results.filter((result) => result.passed).length;
  const byCohort = (name) => {
    const rows = results.filter((result) => result.cohort === name);
    return rows.length === 0 ? 1 : rows.filter((row) => row.passed).length / rows.length;
  };

  return {
    results,
    counts: { passed, nonChartable, falseEntries },
    metrics: {
      cases: results.length,
      exactMatch: passed / results.length,
      falseEntryRate: nonChartable === 0 ? 0 : falseEntries / nonChartable,
      alignmentErrors,
      correctionSuccess: byCohort('corrections'),
      contextSuccess: byCohort('context'),
      parserP50Ms: percentile(parserSamples, 0.5),
      parserP95Ms: percentile(parserSamples, 0.95),
    },
  };
}

function printCohorts(results) {
  console.log(`${'cohort'.padEnd(16)} ${'cases'.padStart(6)} ${'exact'.padStart(7)} ${'false entries'.padStart(14)}`);
  console.log('-'.repeat(47));
  for (const [cohort, row] of cohortTable(results)) {
    const rate = (row.passed / row.total).toFixed(3);
    console.log(`${cohort.padEnd(16)} ${String(row.total).padStart(6)} ${rate.padStart(7)} ${String(row.falseEntries).padStart(14)}`);
  }
}

function printFailures(results, verbose) {
  const failures = results.filter((result) => !result.passed);
  if (failures.length === 0 && !verbose) return;
  console.log('\nfailing cases:');
  for (const failure of failures) {
    const pass = failure.pass === null ? '' : `/${failure.pass}`;
    console.log(`  ${failure.id}${pass} [${failure.cohort}]`);
    for (const reason of failure.failures) console.log(`      ${reason}`);
  }
}

function printMetrics(evaluation) {
  const { counts, metrics } = evaluation;
  console.log('\nmetrics:');
  console.log(`  clinical exact match      ${metrics.exactMatch.toFixed(4)}  (${counts.passed}/${metrics.cases})`);
  console.log(`  false chart entry rate    ${metrics.falseEntryRate.toFixed(4)}  (${counts.falseEntries}/${counts.nonChartable} utterances that must never chart)`);
  console.log(`  site alignment errors     ${metrics.alignmentErrors}`);
  console.log(`  correction success        ${metrics.correctionSuccess.toFixed(4)}`);
  console.log(`  context success           ${metrics.contextSuccess.toFixed(4)}`);
  console.log(`  parser latency p50 / p95  ${metrics.parserP50Ms?.toFixed(2)} ms / ${metrics.parserP95Ms?.toFixed(2)} ms`);
}

function corpusGateProblems(metrics) {
  const problems = [];
  if (metrics.exactMatch < THRESHOLDS.exactMatch) {
    problems.push(`clinical exact match ${metrics.exactMatch.toFixed(4)} is below ${THRESHOLDS.exactMatch}`);
  }
  if (metrics.falseEntryRate > THRESHOLDS.falseEntryRate) {
    problems.push(`false chart entry rate ${metrics.falseEntryRate.toFixed(4)} exceeds ${THRESHOLDS.falseEntryRate}`);
  }
  if (metrics.alignmentErrors > THRESHOLDS.alignmentErrors) {
    problems.push(`${metrics.alignmentErrors} site alignment error(s); values landed on the wrong sites`);
  }
  if (metrics.correctionSuccess < THRESHOLDS.correctionSuccess) {
    problems.push(`correction success ${metrics.correctionSuccess.toFixed(4)} is below ${THRESHOLDS.correctionSuccess}`);
  }
  if (metrics.contextSuccess < THRESHOLDS.contextSuccess) {
    problems.push(`context success ${metrics.contextSuccess.toFixed(4)} is below ${THRESHOLDS.contextSuccess}`);
  }
  if ((metrics.parserP95Ms ?? 0) > THRESHOLDS.parserP95Ms) {
    problems.push(`parser p95 ${metrics.parserP95Ms?.toFixed(2)} ms exceeds ${THRESHOLDS.parserP95Ms} ms`);
  }
  return problems;
}

function schemaError(source, location, message) {
  throw new Error(`${source}: ${location} ${message}`);
}

function schemaObject(value, source, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    schemaError(source, location, 'must be an object');
  }
  return value;
}

function schemaArray(value, source, location) {
  if (!Array.isArray(value)) schemaError(source, location, 'must be an array');
  return value;
}

function schemaString(value, source, location, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    schemaError(source, location, `must be a${allowEmpty ? '' : ' non-empty'} string`);
  }
  return value;
}

function schemaFinite(value, source, location, { minimum = -Infinity, maximum = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    schemaError(source, location, `must be a finite number from ${minimum} through ${maximum}`);
  }
  return value;
}

function schemaNullableFinite(value, source, location, limits = {}) {
  return value === null ? null : schemaFinite(value, source, location, limits);
}

function validateTranscriptReport(value, source) {
  const report = schemaObject(value, source, 'root');
  if (report.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION) {
    schemaError(source, 'schemaVersion', `must be ${TRANSCRIPT_SCHEMA_VERSION}`);
  }
  if (report.kind !== 'perio-dental-transcripts') {
    schemaError(source, 'kind', "must be 'perio-dental-transcripts' (sweep and plan files cannot be replayed)");
  }

  const fixture = schemaObject(report.fixture, source, 'fixture');
  if (!['string', 'number'].includes(typeof fixture.schemaVersion)) {
    schemaError(source, 'fixture.schemaVersion', 'must be a string or number');
  }
  if (!['string', 'number'].includes(typeof fixture.fixtureVersion)) {
    schemaError(source, 'fixture.fixtureVersion', 'must be a string or number');
  }
  if (fixture.sampleRate !== 16_000) {
    schemaError(source, 'fixture.sampleRate', 'must be 16000');
  }
  const passes = schemaArray(fixture.passes, source, 'fixture.passes').map((pass, index) => (
    schemaString(pass, source, `fixture.passes[${index}]`)
  ));
  if (passes.length !== 2 || new Set(passes).size !== 2 || !passes.includes('quiet') || !passes.includes('noise')) {
    schemaError(source, 'fixture.passes', "must contain exactly 'quiet' and 'noise'");
  }

  schemaString(report.model, source, 'model');
  schemaString(report.device, source, 'device');
  schemaString(report.computeType, source, 'computeType');
  if (!Number.isInteger(report.beamSize) || report.beamSize < 1) {
    schemaError(source, 'beamSize', 'must be a positive integer');
  }
  schemaString(report.language, source, 'language');
  const bias = schemaObject(report.bias, source, 'bias');
  if (!['off', 'prompt', 'hotwords'].includes(bias.mode)) {
    schemaError(source, 'bias.mode', 'must be off, prompt, or hotwords');
  }
  if (typeof bias.enabled !== 'boolean' || bias.enabled !== (bias.mode !== 'off')) {
    schemaError(source, 'bias.enabled', 'must agree with bias.mode');
  }

  const scenarioIds = new Set();
  const utteranceIds = new Set();
  const utteranceById = new Map();
  const scenarios = schemaArray(report.scenarios, source, 'scenarios').map((rawScenario, scenarioIndex) => {
    const location = `scenarios[${scenarioIndex}]`;
    const scenario = schemaObject(rawScenario, source, location);
    const id = schemaString(scenario.id, source, `${location}.id`);
    if (scenarioIds.has(id)) schemaError(source, `${location}.id`, `duplicates scenario '${id}'`);
    scenarioIds.add(id);
    const cohort = schemaString(scenario.cohort, source, `${location}.cohort`);
    const expect = schemaObject(scenario.expect, source, `${location}.expect`);
    const start = scenario.start === undefined
      ? undefined
      : schemaObject(scenario.start, source, `${location}.start`);
    const settings = scenario.settings === undefined
      ? undefined
      : schemaObject(scenario.settings, source, `${location}.settings`);
    const utterances = schemaArray(scenario.utterances, source, `${location}.utterances`).map(
      (rawUtterance, utteranceIndex) => {
        const utteranceLocation = `${location}.utterances[${utteranceIndex}]`;
        const utterance = schemaObject(rawUtterance, source, utteranceLocation);
        const utteranceId = schemaString(utterance.id, source, `${utteranceLocation}.id`);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(utteranceId)) {
          schemaError(source, `${utteranceLocation}.id`, 'is not filesystem-safe');
        }
        if (utteranceIds.has(utteranceId)) {
          schemaError(source, `${utteranceLocation}.id`, `duplicates global utterance '${utteranceId}'`);
        }
        utteranceIds.add(utteranceId);
        const prompt = schemaString(utterance.prompt, source, `${utteranceLocation}.prompt`);
        const chartable = utterance.chartable ?? true;
        if (typeof chartable !== 'boolean') {
          schemaError(source, `${utteranceLocation}.chartable`, 'must be a boolean');
        }
        const speaker = utterance.speaker ?? null;
        if (speaker !== null && !['clinician', 'other', 'unknown'].includes(speaker)) {
          schemaError(source, `${utteranceLocation}.speaker`, 'must be clinician, other, or unknown');
        }
        const overridden = utterance.overridden ?? false;
        if (typeof overridden !== 'boolean') {
          schemaError(source, `${utteranceLocation}.overridden`, 'must be a boolean');
        }
        const normalized = { id: utteranceId, prompt, chartable, speaker, overridden };
        utteranceById.set(utteranceId, { ...normalized, scenarioId: id, cohort });
        return normalized;
      },
    );
    if (utterances.length === 0) schemaError(source, `${location}.utterances`, 'must not be empty');
    return { id, cohort, expect, start, settings, utterances };
  });
  if (scenarios.length === 0) schemaError(source, 'scenarios', 'must not be empty');

  const resultByIdentity = new Map();
  const results = schemaArray(report.results, source, 'results').map((rawResult, resultIndex) => {
    const location = `results[${resultIndex}]`;
    const result = schemaObject(rawResult, source, location);
    const pass = schemaString(result.pass, source, `${location}.pass`);
    if (!passes.includes(pass)) schemaError(source, `${location}.pass`, `is unknown: '${pass}'`);
    const utteranceId = schemaString(result.utteranceId, source, `${location}.utteranceId`);
    const expected = utteranceById.get(utteranceId);
    if (!expected) schemaError(source, `${location}.utteranceId`, `is unknown: '${utteranceId}'`);
    const scenarioId = schemaString(result.scenarioId, source, `${location}.scenarioId`);
    if (scenarioId !== expected.scenarioId) {
      schemaError(source, `${location}.scenarioId`, `does not own utterance '${utteranceId}'`);
    }
    if (result.cohort !== expected.cohort) {
      schemaError(source, `${location}.cohort`, `does not match scenario '${scenarioId}'`);
    }
    if (result.reference !== expected.prompt) {
      schemaError(source, `${location}.reference`, `does not match manifest prompt for '${utteranceId}'`);
    }
    if (result.chartable !== expected.chartable) {
      schemaError(source, `${location}.chartable`, `does not match manifest utterance '${utteranceId}'`);
    }
    const transcript = schemaString(result.transcript, source, `${location}.transcript`, { allowEmpty: true });
    const wer = schemaFinite(result.wer, source, `${location}.wer`, { minimum: 0 });
    const noSpeechProbability = schemaNullableFinite(
      result.noSpeechProbability,
      source,
      `${location}.noSpeechProbability`,
      { minimum: 0, maximum: 1 },
    );
    const averageLogProbability = schemaNullableFinite(
      result.averageLogProbability,
      source,
      `${location}.averageLogProbability`,
    );
    if (!Number.isInteger(result.decodeMs) || result.decodeMs < 0) {
      schemaError(source, `${location}.decodeMs`, 'must be a non-negative integer');
    }
    if (result.audioMs !== undefined && (!Number.isInteger(result.audioMs) || result.audioMs < 1)) {
      schemaError(source, `${location}.audioMs`, 'must be a positive integer when present');
    }
    // A live stream can end one recording in several finals -- the endpointer may
    // cut speech, or a sound after it may become its own utterance. The pipeline
    // sees each as a separate utterance, so scoring them joined would hide both.
    let finals = null;
    if (result.finals !== undefined) {
      if (!Array.isArray(result.finals) || result.finals.length === 0
        || result.finals.some((text) => typeof text !== 'string')) {
        schemaError(source, `${location}.finals`, 'must be a non-empty array of strings when present');
      }
      finals = result.finals;
    }
    const identity = `${pass}\u0000${utteranceId}`;
    if (resultByIdentity.has(identity)) {
      schemaError(source, location, `duplicates pass '${pass}' and utterance '${utteranceId}'`);
    }
    const normalized = {
      pass,
      scenarioId,
      utteranceId,
      transcript,
      wer,
      noSpeechProbability,
      averageLogProbability,
      decodeMs: result.decodeMs,
      audioMs: result.audioMs,
      finals,
    };
    resultByIdentity.set(identity, normalized);
    return normalized;
  });

  const missing = [];
  for (const pass of passes) {
    for (const utteranceId of utteranceIds) {
      if (!resultByIdentity.has(`${pass}\u0000${utteranceId}`)) missing.push(`${pass}/${utteranceId}`);
    }
  }
  if (missing.length > 0) {
    schemaError(source, 'results', `is missing ${missing.length} recording(s): ${missing.slice(0, 5).join(', ')}`);
  }
  if (results.length !== passes.length * utteranceIds.size) {
    schemaError(source, 'results', 'contains an unexpected recording count');
  }

  const missingAudio = schemaArray(report.missingAudio, source, 'missingAudio');
  if (missingAudio.length > 0) {
    schemaError(source, 'missingAudio', 'must be empty before clinical replay');
  }
  const summary = schemaObject(report.summary, source, 'summary');
  if (summary.complete !== true) schemaError(source, 'summary.complete', 'must be true');
  if (summary.expectedResults !== results.length || summary.decodedResults !== results.length) {
    schemaError(source, 'summary', 'recording counts do not match validated results');
  }

  return { report, fixture, passes, scenarios, resultByIdentity };
}

function transcriptCases(validated) {
  return validated.passes.flatMap((pass) => validated.scenarios.map((scenario) => ({
    id: scenario.id,
    pass,
    cohort: scenario.cohort,
    start: scenario.start,
    settings: scenario.settings,
    expect: scenario.expect,
    utterances: scenario.utterances.flatMap((utterance) => {
      const result = validated.resultByIdentity.get(`${pass}\u0000${utterance.id}`);
      const texts = result.finals ?? [result.transcript];
      return texts.map((text) => ({
        text,
        chartable: utterance.chartable,
        // A recording made with one voice cannot carry who is speaking, so the
        // manifest declares it, as the transcript corpus does. Dropping it here
        // made every attribution scenario chart as if the clinician had spoken.
        speaker: utterance.speaker,
        overridden: utterance.overridden === true,
        noSpeechProbability: result.noSpeechProbability,
        averageLogProbability: result.averageLogProbability,
        decodeMs: result.decodeMs,
        audioMs: result.audioMs,
      }));
    }),
  })));
}

function loadTranscriptReport(path) {
  let loaded;
  try {
    loaded = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${path}: invalid JSON: ${error.message}`);
    throw error;
  }
  return validateTranscriptReport(loaded, path);
}

const RELEVANCE_MODES = new Set(['enforce', 'balanced', 'shadow']);

function parseArguments(argv) {
  const options = { gate: false, verbose: false, transcripts: null, help: false, relevanceMode: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--gate') options.gate = true;
    else if (argument === '--verbose') options.verbose = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--transcripts') {
      const path = argv[index + 1];
      if (!path || path.startsWith('--')) throw new Error('--transcripts requires a JSON file path');
      options.transcripts = path;
      index += 1;
    } else if (argument.startsWith('--transcripts=')) {
      options.transcripts = argument.slice('--transcripts='.length);
      if (!options.transcripts) throw new Error('--transcripts requires a JSON file path');
    } else if (argument === '--relevance-mode') {
      const mode = argv[index + 1];
      if (!mode || !RELEVANCE_MODES.has(mode)) {
        throw new Error('--relevance-mode requires one of: enforce, balanced, shadow');
      }
      options.relevanceMode = mode;
      index += 1;
    } else if (argument.startsWith('--relevance-mode=')) {
      const mode = argument.slice('--relevance-mode='.length);
      if (!RELEVANCE_MODES.has(mode)) {
        throw new Error('--relevance-mode requires one of: enforce, balanced, shadow');
      }
      options.relevanceMode = mode;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.gate && options.transcripts) {
    throw new Error('--gate applies only to the versioned clinical corpus; dental thresholds require a measured baseline');
  }
  return options;
}

function printHelp() {
  console.log('Usage: node scripts/evaluate-clinical.mjs [--gate] [--verbose] [--relevance-mode enforce|balanced|shadow]');
  console.log('       node scripts/evaluate-clinical.mjs --transcripts <dental-transcripts.json> [--verbose] [--relevance-mode enforce|balanced|shadow]');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.transcripts) {
    const validated = loadTranscriptReport(options.transcripts);
    const domain = await loadDomain();
    const cases = transcriptCases(validated);
    const evaluation = evaluateCases(domain, cases, options.relevanceMode);
    const { fixture, report } = validated;
    console.log(
      `dental fixture ${fixture.fixtureVersion} · model ${report.model} · `
      +
      `${report.results.length} recognized utterances · ${cases.length} pass/scenario cases\n`,
    );
    printCohorts(evaluation.results);
    printFailures(evaluation.results, options.verbose);
    printMetrics(evaluation);
    console.log('\nDENTAL_CLINICAL_EVALUATION_COMPLETE');
    return 0;
  }

  const domain = await loadDomain();
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const evaluation = evaluateCases(domain, corpus.cases, options.relevanceMode);
  const modeNote = options.relevanceMode ? ` · relevance mode ${options.relevanceMode}` : '';
  console.log(`corpus ${corpus.version} · lexicon ${domain.LEXICON_VERSION} · ${evaluation.results.length} cases${modeNote}\n`);
  printCohorts(evaluation.results);
  printFailures(evaluation.results, options.verbose);
  printMetrics(evaluation);

  if (!options.gate) return 0;
  const problems = corpusGateProblems(evaluation.metrics);
  for (const problem of problems) console.log(`FAIL: ${problem}`);
  console.log(problems.length === 0 ? 'CLINICAL_EVAL_GATE_PASSED' : 'CLINICAL_EVAL_GATE_FAILED');
  return problems.length === 0 ? 0 : 1;
}

export {
  evaluateCases,
  loadTranscriptReport,
  main,
  transcriptCases,
  validateTranscriptReport,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`CLINICAL_EVALUATION_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
