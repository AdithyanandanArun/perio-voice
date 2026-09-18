import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MANIFEST_PATH = 'evaluation/fixtures/dental/phrases.json';
const AUDIO_PATH = 'evaluation/fixtures/dental/audio';
const EXPECTED_COHORTS = [
  'accent',
  'ambiguity',
  'clean',
  'context',
  'conversational',
  'corrections',
  'multispeaker',
  'negation',
  'rapid',
  'sequence',
  'terminology',
];
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateManifest(manifest) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!isObject(manifest)) return ['manifest must be a JSON object'];
  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof manifest.fixtureVersion !== 'string' || !manifest.fixtureVersion.trim()) {
    fail('fixtureVersion must be a non-empty string');
  }
  if (manifest.sampleRate !== 16_000) fail('sampleRate must be 16000');
  if (!Array.isArray(manifest.passes)
      || manifest.passes.length !== 2
      || manifest.passes[0] !== 'quiet'
      || manifest.passes[1] !== 'noise') {
    fail('passes must be the ordered pair ["quiet", "noise"]');
  }
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) {
    fail('scenarios must be a non-empty array');
    return errors;
  }

  const scenarioIds = new Set();
  const utteranceIds = new Set();
  const cohorts = new Set();
  let utteranceCount = 0;
  let nonChartableCount = 0;

  manifest.scenarios.forEach((scenario, scenarioIndex) => {
    const at = `scenarios[${scenarioIndex}]`;
    if (!isObject(scenario)) {
      fail(`${at} must be an object`);
      return;
    }
    if (typeof scenario.id !== 'string' || !SAFE_ID.test(scenario.id)) {
      fail(`${at}.id must be filesystem-safe lowercase kebab-case`);
    } else if (scenarioIds.has(scenario.id)) {
      fail(`${at}.id duplicates ${scenario.id}`);
    } else {
      scenarioIds.add(scenario.id);
    }
    if (!EXPECTED_COHORTS.includes(scenario.cohort)) {
      fail(`${at}.cohort is not one of the eleven clinical cohorts`);
    } else {
      cohorts.add(scenario.cohort);
    }
    if ('start' in scenario && !isObject(scenario.start)) fail(`${at}.start must be an object`);
    if ('settings' in scenario && !isObject(scenario.settings)) {
      fail(`${at}.settings must be an object`);
    }
    if (!isObject(scenario.expect) || Object.keys(scenario.expect).length === 0) {
      fail(`${at}.expect must be a non-empty structured outcome`);
    }
    if (!Array.isArray(scenario.utterances) || scenario.utterances.length === 0) {
      fail(`${at}.utterances must be a non-empty ordered array`);
      return;
    }
    scenario.utterances.forEach((utterance, utteranceIndex) => {
      const utteranceAt = `${at}.utterances[${utteranceIndex}]`;
      utteranceCount += 1;
      if (!isObject(utterance)) {
        fail(`${utteranceAt} must be an object`);
        return;
      }
      if (typeof utterance.id !== 'string' || !SAFE_ID.test(utterance.id)) {
        fail(`${utteranceAt}.id must be filesystem-safe lowercase kebab-case`);
      } else if (utteranceIds.has(utterance.id)) {
        fail(`${utteranceAt}.id duplicates ${utterance.id}`);
      } else {
        utteranceIds.add(utterance.id);
      }
      if (typeof utterance.prompt !== 'string'
          || !utterance.prompt.trim()
          || utterance.prompt !== utterance.prompt.trim()
          || hasControlCharacter(utterance.prompt)) {
        fail(`${utteranceAt}.prompt must be trimmed, non-empty printable text`);
      }
      if ('chartable' in utterance && typeof utterance.chartable !== 'boolean') {
        fail(`${utteranceAt}.chartable must be boolean when present`);
      }
      if (utterance.chartable === false) nonChartableCount += 1;
    });
  });

  if (utteranceCount < 60) fail(`manifest has ${utteranceCount} prompts; at least 60 are required`);
  if (nonChartableCount === 0) fail('manifest needs at least one non-chartable control');
  for (const cohort of EXPECTED_COHORTS) {
    if (!cohorts.has(cohort)) fail(`manifest does not cover cohort ${cohort}`);
  }
  return errors;
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function validatePrivacy() {
  const errors = [];
  const tracked = git(['ls-files', '--', 'evaluation/fixtures/dental']);
  if (tracked.status !== 0) errors.push(`git ls-files failed: ${tracked.stderr.trim()}`);
  const trackedAudio = tracked.stdout.split(/\r?\n/).filter((path) =>
    path.startsWith(`${AUDIO_PATH}/`)
    && /\.(?:wav|pcm|flac|mp3|m4a|ogg|webm)$/i.test(path));
  if (trackedAudio.length) errors.push(`voice audio is tracked: ${trackedAudio.join(', ')}`);

  const ignored = git(['check-ignore', '-q', `${AUDIO_PATH}/.privacy-probe.wav`]);
  if (ignored.status !== 0) errors.push(`${AUDIO_PATH}/ is not covered by .gitignore`);
  for (const path of [
    MANIFEST_PATH,
    'evaluation/fixtures/dental/metrics.json',
    'evaluation/fixtures/dental/tts/clean-depths-u01.wav',
  ]) {
    if (git(['check-ignore', '-q', path]).status === 0) {
      errors.push(`${path} must remain committable`);
    }
  }
  return errors;
}

if (process.argv.length !== 3 || process.argv[2] !== '--manifest') {
  console.error('usage: node scripts/verify-fixture-capture.mjs --manifest');
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
} catch (error) {
  console.error(`cannot read ${MANIFEST_PATH}: ${error.message}`);
  process.exit(1);
}

const errors = [...validateManifest(manifest), ...validatePrivacy()];
if (errors.length) {
  for (const error of errors) console.error(`fixture manifest: ${error}`);
  process.exit(1);
}

console.log('FIXTURE_MANIFEST_GATE_PASSED');
