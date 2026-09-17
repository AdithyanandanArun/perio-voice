# Gates: active local voice recognition milestone

OWNS: .gitignore, .python-version, ARCHITECTURE.md, GATES.md, README.md, package.json, package-lock.json, pyproject.toml, uv.lock, vite.config.ts, public/**, server/**, src/**, tests/**, scripts/**

Scope: Replace browser-vendor speech recognition with an active local Faster-Whisper service, stream microphone PCM from the browser with explicit lifecycle and latency states, preserve the clinical engine boundary, and document the low-latency architecture for every post-milestone capability.

- [ ] G0: this completion ledger states executable outcomes that can fail
  CHECK: node /home/adithyan/.codex/skills/unlazy/scripts/gate-lint.mjs GATES.md
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
