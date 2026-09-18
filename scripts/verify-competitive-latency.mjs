import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Check the written latency/competitive contract without running a model.
 *
 * This is intentionally a source-and-mapping check, not a web scraper or a
 * CareStack benchmark. The public URLs are required to remain visible in the
 * gap analysis, while every accepted gap must point to local evidence or an
 * explicit non-claim/handoff. A missing-marker probe is kept as a negative
 * control so this script cannot silently become an always-pass existence check.
 */

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const readme = read('README.md');
const architecture = read('ARCHITECTURE.md');
const evaluation = read('EVALUATION.md');
const gap = read('docs/CARESTACK_LATENCY_GAP_ANALYSIS.md');
const liveEvaluator = read('scripts/verify_live_recognizer.py');
const qualityGate = read('scripts/verify_latency_quality.py');

const failures = [];

function missingMarkers(label, source, markers) {
  return markers
    .filter((marker) => !source.includes(marker))
    .map((marker) => `${label} is missing: ${marker}`);
}

function requireMarkers(label, source, markers) {
  failures.push(...missingMarkers(label, source, markers));
}

requireMarkers('CareStack analysis sections', gap, [
  '## Executive reading',
  '## Sources and evidence classification',
  '## Gap map',
  '## Accepted limits and non-claims',
  '## Handoff questions for a real competitive study',
]);

requireMarkers('CareStack analysis topics', gap, [
  'Manual correction and edit limits',
  'Auto-advance and positional drift',
  'Cloud/network dependence',
  'Noise and background speech',
  'Rigid command vocabulary and omitted grades',
  'Double-digit and negative entry friction',
  'Auditability and record history',
  'Recovery and user feedback',
  'Configuration and tenant variation',
  'Latency evidence',
  'Grade 1',
  'negative gingival-margin',
  'not a CareStack defect claim',
  'does not establish',
  'handoff',
]);

// Keep official sources in the artifact so a future reviewer can re-open the
// exact pages. The analysis deliberately does not rely on an unverified blog or
// on a proprietary implementation claim.
requireMarkers('official CareStack URLs', gap, [
  'https://carestack.com/en-GB/dental-software/features/voice-perio',
  'https://carestack.zendesk.com/hc/en-us/articles/47790792843924-Voice-Perio-Perio-Charting-with-Voice-Commands',
  'https://carestack.zendesk.com/hc/en-us/articles/30313408675604-Explore-Perio-Charting',
  'https://carestack-aus.zendesk.com/hc/en-au/articles/25869211238034-Configure-Perio-Charting-and-Manage-Permissions',
  'https://carestack.com/dental-software/features/periodontal-charting',
  'https://carestack.com/dental-software/integrations',
]);

// Every row of the gap map must end in an implementation path, a test path, or
// a clearly named handoff/non-claim. These are representative anchors for all
// rows, not an assertion that the local prototype integrates with CareStack.
const mappings = [
  'src/domain/correction.ts',
  'src/domain/journal.ts',
  'tests/corrections.test.ts',
  'src/domain/workflow.ts',
  'src/domain/sequenceGuard.ts',
  'tests/sequenceGuard.test.ts',
  'src/speech/useLocalAsr.ts',
  'server/app.py',
  'server/speech_presence.py',
  'tests/server/test_speech_presence.py',
  'src/domain/grammar.ts',
  'src/domain/negation.ts',
  'tests/negation.test.ts',
  'src/domain/lattice.ts',
  'src/domain/contextResolver.ts',
  'tests/disambiguation.test.ts',
  'src/components/HistoryPanel.tsx',
  'tests/transactionSafety.test.ts',
  'src/components/CapturePanel.tsx',
  'tests/accessibility.test.tsx',
  'server/config.py',
  'tests/server/test_config.py',
  'scripts/verify_live_recognizer.py',
  'scripts/verify_latency_quality.py',
  'negative gingival-margin',
  'explicit non-claim',
  'handoff',
];
requireMarkers('gap-map evidence/mapping', gap, mappings);

// Every repository path cited in the gap map must actually exist. A path is
// evidence only if a future reviewer can open it; a stale or invented path
// would silently rot the analysis into an unverifiable claim.
function missingRepoPaths(paths) {
  return paths.filter((path) => path.includes('/') && !existsSync(resolve(root, path)));
}

const citedRepoPaths = mappings.filter(
  (mapping) => mapping.includes('/') && !mapping.includes(' '),
);
for (const path of missingRepoPaths(citedRepoPaths)) {
  failures.push(`gap-map cites a repository path that does not exist: ${path}`);
}

// Negative control: run the same existence check against a deliberately
// fabricated path alongside a real one, and require it (and only it) to be
// rejected -- proving this cannot become an always-pass existence check.
const pathProbe = missingRepoPaths([
  'src/domain/correction.ts',
  'src/domain/this-path-does-not-exist-negative-control.ts',
]);
if (pathProbe.length !== 1 || !pathProbe[0].includes('does-not-exist')) {
  failures.push('path-existence negative control did not detect a missing file');
}

requireMarkers('README latency contract', readme, [
  'scripts/verify_latency_quality.py --unit',
  'scripts/verify-competitive-latency.mjs',
  '98/104',
  'endpoint/sample timing',
  'endpoint→final p95 ≤450 ms',
  'semantic\nlast-voiced-sample→endpoint hangover ≤200 ms',
  'not clinical claims',
  'docs/CARESTACK_LATENCY_GAP_ANALYSIS.md',
]);

requireMarkers('architecture latency contract', architecture, [
  'endpoint',
  'lastVoiceSample',
  'endSample - lastVoiceSample',
  'audio_gap',
  'p95 ≤450 ms',
  'p95 ≤650 ms',
  'verify_latency_quality.py',
  'old server',
  'without endpoint/sample events',
  'docs/CARESTACK_LATENCY_GAP_ANALYSIS.md',
]);

requireMarkers('evaluation latency contract', evaluation, [
  'scripts/verify_live_recognizer.py --gate',
  'scripts/verify_latency_quality.py --unit',
  'scripts/verify_latency_quality.py --gate',
  'endpoint/sample timing',
  'last-voiced-sample',
  'endpoint→final',
  '98/104',
  '450 ms',
  '200 ms',
  '650 ms',
  'not a clinical claim',
  'docs/CARESTACK_LATENCY_GAP_ANALYSIS.md',
]);

requireMarkers('live evaluator evidence', liveEvaluator, [
  'endpoint',
  'speech_end',
  'lastVoiceSample',
  'sampleEvidence',
  'endpoint_to_final_ms',
  'semantic_hangover_ms',
  'last_voice_to_final_ms',
  'timed_endpoint_messages',
  'legacy_latency_finals',
  'endpointReason',
  'VALID_ENDPOINT_REASONS',
  'chartableTextFinals',
  'semanticChartableTextFinals',
  // F8: this evaluator's own --gate decides only G44 (90%/700 ms); the
  // strict 450/200/650/80% contract lives entirely in
  // verify_latency_quality.py, so those numbers must NOT appear here.
  'GATE_MIN_CHART = 0.90',
  'GATE_MAX_ENDPOINT_TO_FINAL_P95_MS = 700',
  'g44_contract_failures',
]);

requireMarkers('independent latency gate', qualityGate, [
  '--unit',
  '--gate',
  'control_failures',
  'timed_endpoint_messages',
  'MAX_ENDPOINT_TO_FINAL_P95_MS = 450.0',
  'MAX_SEMANTIC_HANGOVER_MS = 200.0',
  'MIN_SEMANTIC_COVERAGE = 0.80',
  'semantic_chartable_text_finals',
  'finals_with_reason',
  'finals_with_last_voice_sample',
  'g44_contract_failures',
  'run_g44_contract_unit',
  'G44_CONTRACT_UNIT_PASSED',
  'LATENCY_QUALITY_UNIT_PASSED',
  'LATENCY_QUALITY_GATE_PASSED',
]);

// Negative control: remove the required timing marker from a tiny synthetic
// document and ensure the same marker oracle actually reports a failure.
const negativeProbe = missingMarkers('negative control', 'README without timing', [
  'endpoint/sample timing',
]);
const negativeControlPassed = negativeProbe.length === 1;
if (!negativeControlPassed) {
  failures.push('negative control did not detect a deliberately missing marker');
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(`Competitive latency contract failed with ${failures.length} assertion(s).`);
  process.exitCode = 1;
} else {
  console.log('negative control: missing marker rejected');
  console.log('COMPETITIVE_LATENCY_CONTRACT_PASSED');
}
