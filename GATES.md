# Gates: clinical voice intelligence layer

OWNS: .gitignore, .python-version, ARCHITECTURE.md, EVALUATION.md, GATES.md, README.md, eval/**, package.json, package-lock.json, pyproject.toml, uv.lock, vite.config.ts, public/**, server/**, src/**, tests/**, scripts/**

Scope: Milestone 1 delivered active local Faster-Whisper recognition and a deterministic three-site periodontal engine. Milestone 2 builds the clinical voice intelligence layer above it: relevance filtering, sequence protection, context-aware disambiguation, negation scope, natural corrections with an append-only journal, noise robustness, speaker attribution, cadence-adaptive endpointing, full-mouth context recovery, dental terminology and accent handling, plus the evaluation harness that measures all of it.

## Milestone 1 — active local recognition

- [ ] G0: this completion ledger states executable outcomes that can fail
  CHECK: node /home/adithyan/.claude/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: server audio framing, speech segmentation, backpressure, and session state pass deterministic tests
  CHECK: node scripts/verify-server-domain.mjs
  EXPECT: SERVER_DOMAIN_GATE_PASSED
  EVIDENCE: pending

- [ ] G2: the real local Faster-Whisper model loads and recognizes known spoken audio without a mock
  CHECK: uv run python scripts/verify_model_runtime.py
  EXPECT: ACTIVE_MODEL_GATE_PASSED
  EVIDENCE: pending

- [ ] G3: the FastAPI health and binary WebSocket protocol produce model, speech, partial, final, metrics, stop, and error messages correctly
  CHECK: node scripts/verify-asr-api.mjs
  EXPECT: ASR_API_GATE_PASSED
  EVIDENCE: pending

- [ ] G4: the browser audio pipeline captures, resamples, batches, streams, reconnects, and cleans up microphone resources
  CHECK: node scripts/verify-browser-audio.mjs
  EXPECT: BROWSER_AUDIO_GATE_PASSED
  EVIDENCE: pending

- [ ] G5: real ASR partial and final messages drive visible engine states and structured chart commits while the simulator remains available
  CHECK: node scripts/verify-active-workflow.mjs
  EXPECT: ACTIVE_WORKFLOW_GATE_PASSED
  EVIDENCE: pending

- [ ] G6: the unified development command boots the backend and frontend, exposes model health, and shuts both down cleanly
  CHECK: node scripts/verify-dev-runtime.mjs
  EXPECT: DEV_RUNTIME_GATE_PASSED
  EVIDENCE: pending

- [ ] G7: existing periodontal parsing, corrections, negation, context, relevance, homophones, sequence protection, and latency behavior remain regression-safe
  CHECK: node scripts/verify-domain.mjs
  EXPECT: DOMAIN_GATE_PASSED
  EVIDENCE: pending

- [ ] G8: Python and TypeScript linting, strict type checks, tests, and the production frontend build pass
  CHECK: node scripts/verify-quality.mjs
  EXPECT: QUALITY_GATE_PASSED
  EVIDENCE: pending

- [ ] G9: the interface exposes accessible model-loading, offline, listening, processing, error-recovery, and fallback states
  CHECK: node scripts/verify-accessibility.mjs
  EXPECT: ACCESSIBILITY_GATE_PASSED
  EVIDENCE: pending

- [ ] G10: setup, model operation, protocol, latency budget, observability, deployment, safety boundaries, and every later build-order capability have implementable architecture documentation
  CHECK: node scripts/verify-architecture.mjs
  EXPECT: ARCHITECTURE_GATE_PASSED
  EVIDENCE: pending

## Milestone 2 — clinical voice intelligence layer

- [ ] G11: a versioned dental lexicon canonicalizes terminology, abbreviations, and recognizer confusions, and supplies recognizer hotwords
  CHECK: node scripts/verify-lexicon.mjs
  EXPECT: LEXICON_GATE_PASSED
  EVIDENCE: pending

- [ ] G12: the relevance classifier keeps conversational, patient-directed, and assistant-directed speech out of the chart while still admitting terse clinical speech
  CHECK: node scripts/verify-relevance.mjs
  EXPECT: RELEVANCE_GATE_PASSED
  EVIDENCE: pending

- [ ] G13: the candidate lattice and context resolver map ambiguous homophones only onto interpretations the active clinical context permits
  CHECK: node scripts/verify-disambiguation.mjs
  EXPECT: DISAMBIGUATION_GATE_PASSED
  EVIDENCE: pending

- [ ] G14: negation cues assign the correct polarity and scope across findings, conjunctions, and pauses
  CHECK: node scripts/verify-negation.mjs
  EXPECT: NEGATION_GATE_PASSED
  EVIDENCE: pending

- [ ] G15: an append-only journal resolves immediate, targeted, and delayed corrections and supports undo and redo without hidden mutation
  CHECK: node scripts/verify-corrections.mjs
  EXPECT: CORRECTIONS_GATE_PASSED
  EVIDENCE: pending

- [ ] G16: the sequence guard rejects inserted, dropped, and duplicated values atomically instead of shifting later sites
  CHECK: node scripts/verify-sequence-guard.mjs
  EXPECT: SEQUENCE_GUARD_GATE_PASSED
  EVIDENCE: pending

- [ ] G17: the full-mouth workflow state machine tracks position through skip, back, resume, and jumps, and rejects finals that observed a stale context
  CHECK: node scripts/verify-workflow-state.mjs
  EXPECT: WORKFLOW_STATE_GATE_PASSED
  EVIDENCE: pending

- [ ] G18: speaker verification accepts the enrolled clinician and blocks unenrolled and unknown speakers from committing chart data
  CHECK: node scripts/verify-speaker.mjs
  EXPECT: SPEAKER_GATE_PASSED
  EVIDENCE: pending

- [ ] G19: endpointing adapts to fast, slow, and uneven cadence inside safe bounds without clipping short utterances
  CHECK: node scripts/verify-cadence.mjs
  EXPECT: CADENCE_GATE_PASSED
  EVIDENCE: pending

- [ ] G20: the acoustic replay harness measures word error rate against synthesized operatory noise at fixed SNR bands and promotes a preprocessing profile only on measured improvement
  CHECK: uv run python scripts/evaluate_acoustic.py --gate
  EXPECT: ACOUSTIC_GATE_PASSED
  EVIDENCE: pending

- [ ] G21: the clinical evaluation harness measures exact match, false chart entry, site alignment error, correction success, and latency per cohort against declared thresholds
  CHECK: node scripts/evaluate-clinical.mjs --gate
  EXPECT: CLINICAL_EVAL_GATE_PASSED
  EVIDENCE: pending

- [ ] G22: the assembled pipeline runs every stage in order, records a stage trace, and keeps parser-side latency inside the declared budget
  CHECK: node scripts/verify-pipeline.mjs
  EXPECT: PIPELINE_GATE_PASSED
  EVIDENCE: pending

- [ ] G23: the interface exposes workflow position, pending confirmations, speaker attribution, undo and redo, and the decision trace accessibly
  CHECK: node scripts/verify-intelligence-ui.mjs
  EXPECT: INTELLIGENCE_UI_GATE_PASSED
  EVIDENCE: pending

- [ ] G24: runtime telemetry emits bounded, identifier-free counters and histograms over the health endpoint
  CHECK: node scripts/verify-telemetry.mjs
  EXPECT: TELEMETRY_GATE_PASSED
  EVIDENCE: pending

- [ ] G25: setup, capability, evaluation, and safety documentation matches the delivered intelligence layer
  CHECK: node scripts/verify-documentation.mjs
  EXPECT: DOCUMENTATION_GATE_PASSED
  EVIDENCE: pending
