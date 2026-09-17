/**
 * Clinical evaluation harness.
 *
 * Replays every case in the versioned corpus through the real pipeline and
 * reports the metrics that actually describe this product: whether the chart
 * ended up correct, how often speech that should never chart did, and whether
 * values landed on the right sites.
 *
 * Word error rate is deliberately not here. It belongs to the acoustic harness,
 * because a word-perfect transcript can still produce a wrong chart and a
 * transcript with errors can still produce a right one. Reporting them together
 * hides which half of the system moved.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { loadDomain } from './lib/domain.mjs';

const CORPUS = 'evaluation/corpus/clinical.json';

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
    audioMs: 700,
    decodeMs: 180,
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

function checkCase(domain, testCase) {
  const failures = [];
  let session = domain.createInitialSession(testCase.settings ?? {});
  if (testCase.start) {
    session = domain.updateContext(session, testCase.start, -1);
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

async function main() {
  const gate = process.argv.includes('--gate');
  const verbose = process.argv.includes('--verbose');
  const domain = await loadDomain();
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const results = corpus.cases.map((testCase) => checkCase(domain, testCase));

  const parserSamples = results.flatMap((result) => result.parserSamples);
  const nonChartable = results.reduce((sum, result) => sum + result.nonChartable, 0);
  const falseEntries = results.reduce((sum, result) => sum + result.falseEntries, 0);
  const alignmentErrors = results.reduce((sum, result) => sum + result.alignmentErrors, 0);
  const passed = results.filter((result) => result.passed).length;

  const byCohort = (name) => {
    const rows = results.filter((result) => result.cohort === name);
    return rows.length === 0 ? 1 : rows.filter((row) => row.passed).length / rows.length;
  };

  const metrics = {
    cases: results.length,
    exactMatch: passed / results.length,
    falseEntryRate: nonChartable === 0 ? 0 : falseEntries / nonChartable,
    alignmentErrors,
    correctionSuccess: byCohort('corrections'),
    contextSuccess: byCohort('context'),
    parserP50Ms: percentile(parserSamples, 0.5),
    parserP95Ms: percentile(parserSamples, 0.95),
  };

  console.log(`corpus ${corpus.version} · lexicon ${domain.LEXICON_VERSION} · ${results.length} cases\n`);
  console.log(`${'cohort'.padEnd(16)} ${'cases'.padStart(6)} ${'exact'.padStart(7)} ${'false entries'.padStart(14)}`);
  console.log('-'.repeat(47));
  for (const [cohort, row] of cohortTable(results)) {
    const rate = (row.passed / row.total).toFixed(3);
    console.log(`${cohort.padEnd(16)} ${String(row.total).padStart(6)} ${rate.padStart(7)} ${String(row.falseEntries).padStart(14)}`);
  }

  const failures = results.filter((result) => !result.passed);
  if (failures.length > 0 || verbose) {
    console.log('\nfailing cases:');
    for (const failure of failures) {
      console.log(`  ${failure.id} [${failure.cohort}]`);
      for (const reason of failure.failures) console.log(`      ${reason}`);
    }
  }

  console.log('\nmetrics:');
  console.log(`  clinical exact match      ${metrics.exactMatch.toFixed(4)}  (${passed}/${results.length})`);
  console.log(`  false chart entry rate    ${metrics.falseEntryRate.toFixed(4)}  (${falseEntries}/${nonChartable} utterances that must never chart)`);
  console.log(`  site alignment errors     ${metrics.alignmentErrors}`);
  console.log(`  correction success        ${metrics.correctionSuccess.toFixed(4)}`);
  console.log(`  context success           ${metrics.contextSuccess.toFixed(4)}`);
  console.log(`  parser latency p50 / p95  ${metrics.parserP50Ms?.toFixed(2)} ms / ${metrics.parserP95Ms?.toFixed(2)} ms`);

  if (!gate) return 0;

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

  for (const problem of problems) console.log(`FAIL: ${problem}`);
  console.log(problems.length === 0 ? 'CLINICAL_EVAL_GATE_PASSED' : 'CLINICAL_EVAL_GATE_FAILED');
  return problems.length === 0 ? 0 : 1;
}

process.exitCode = await main();
