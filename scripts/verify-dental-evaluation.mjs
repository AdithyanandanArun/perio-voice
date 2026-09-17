/**
 * Deterministic verification for the transcript-to-clinical bridge.
 *
 * This intentionally creates transcript JSON in a temporary directory. It
 * verifies schema and clinical replay behavior; it does not pretend synthetic
 * data says anything about microphone or model quality.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('./evaluate-clinical.mjs', import.meta.url));
const ROOT = dirname(dirname(SCRIPT));

function result(pass, utteranceId, transcript, wer) {
  const definitions = {
    depths: { reference: 'three four five', chartable: true },
    conversation: { reference: 'can you pass me that', chartable: false },
  };
  const definition = definitions[utteranceId];
  return {
    pass,
    scenarioId: 'recognized-words-drive-chart',
    cohort: 'clean',
    utteranceId,
    chartable: definition.chartable,
    reference: definition.reference,
    transcript,
    wer,
    noSpeechProbability: 0.08,
    averageLogProbability: -0.21,
    audioMs: 840,
    decodeMs: 42,
  };
}

function syntheticReport() {
  const results = [
    result('quiet', 'depths', 'three four five', 0),
    result('quiet', 'conversation', 'can you pass me that', 0),
    result('noise', 'depths', 'three four six', 1 / 3),
    result('noise', 'conversation', 'bleeding', 1),
  ];
  return {
    schemaVersion: 1,
    kind: 'perio-dental-transcripts',
    fixture: {
      schemaVersion: 1,
      fixtureVersion: 'synthetic-bridge-check',
      sampleRate: 16_000,
      passes: ['quiet', 'noise'],
      manifest: 'temporary/synthetic/phrases.json',
      audioRoot: 'temporary/synthetic',
      scenarioCount: 1,
      utteranceCount: 2,
    },
    model: 'synthetic-not-an-acoustic-claim',
    device: 'test',
    computeType: 'test',
    beamSize: 5,
    language: 'en',
    bias: {
      mode: 'prompt',
      enabled: true,
      promptVersion: 'synthetic',
      promptSha256: 'synthetic',
    },
    scenarios: [
      {
        id: 'recognized-words-drive-chart',
        cohort: 'clean',
        utterances: [
          { id: 'depths', prompt: 'three four five', chartable: true },
          { id: 'conversation', prompt: 'can you pass me that', chartable: false },
        ],
        expect: {
          records: [
            {
              tooth: 14,
              surface: 'buccal',
              probingDepths: [3, 4, 5],
            },
          ],
        },
      },
    ],
    results,
    missingAudio: [],
    extraAudio: [],
    summary: {
      complete: true,
      expectedResults: results.length,
      decodedResults: results.length,
      missingResults: 0,
      extraAudioFiles: 0,
      aggregateWer: 0.35,
      meanWer: 1 / 3,
      wordErrors: 7,
      referenceWords: 20,
      byPass: {},
    },
  };
}

function run(...arguments_) {
  return spawnSync(process.execPath, [SCRIPT, ...arguments_], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const directory = mkdtempSync(join(tmpdir(), 'perio-dental-bridge-'));
try {
  const validPath = join(directory, 'transcripts.json');
  writeJson(validPath, syntheticReport());
  const replay = run('--transcripts', validPath);
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.match(replay.stdout, /clinical exact match\s+0\.5000\s+\(1\/2\)/);
  assert.match(replay.stdout, /false chart entry rate\s+0\.5000\s+\(1\/2 utterances/);
  assert.match(replay.stdout, /site alignment errors\s+1(?:\D|$)/);
  assert.match(replay.stdout, /DENTAL_CLINICAL_EVALUATION_COMPLETE/);

  // Negative control: if the bridge substituted references for recognized text,
  // all three assertions above would read 1.0000, 0.0000, and 0.
  assert.doesNotMatch(replay.stdout, /clinical exact match\s+1\.0000/);

  const missing = syntheticReport();
  missing.results.pop();
  missing.summary.expectedResults -= 1;
  missing.summary.decodedResults -= 1;
  const missingPath = join(directory, 'missing-result.json');
  writeJson(missingPath, missing);
  const missingReplay = run('--transcripts', missingPath);
  assert.notEqual(missingReplay.status, 0, 'a missing pass/utterance result was accepted');
  assert.match(missingReplay.stderr, /results is missing 1 recording/);

  const impossibleProbability = syntheticReport();
  impossibleProbability.results[0].noSpeechProbability = 1.01;
  const probabilityPath = join(directory, 'impossible-probability.json');
  writeJson(probabilityPath, impossibleProbability);
  const probabilityReplay = run('--transcripts', probabilityPath);
  assert.notEqual(probabilityReplay.status, 0, 'an invalid no-speech probability was accepted');
  assert.match(probabilityReplay.stderr, /noSpeechProbability must be a finite number/);

  const plan = syntheticReport();
  plan.kind = 'perio-dental-evaluation-plan';
  const planPath = join(directory, 'plan-not-transcripts.json');
  writeJson(planPath, plan);
  const planReplay = run('--transcripts', planPath);
  assert.notEqual(planReplay.status, 0, 'an inventory plan was accepted as decoded audio');
  assert.match(planReplay.stderr, /sweep and plan files cannot be replayed/);

  const corpus = run('--gate');
  assert.equal(corpus.status, 0, corpus.stderr || corpus.stdout);
  assert.match(corpus.stdout, /CLINICAL_EVAL_GATE_PASSED/);

  console.log('DENTAL_EVALUATION_BRIDGE_PASSED');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
