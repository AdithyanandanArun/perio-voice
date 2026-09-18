# Gates: clinical voice intelligence layer

OWNS: .gitignore, .python-version, ARCHITECTURE.md, EVALUATION.md, GATES.md, README.md, evaluation/**, package.json, package-lock.json, pyproject.toml, uv.lock, vite.config.ts, tsconfig.app.json, public/**, server/**, shared/**, src/**, tests/**, scripts/**

Scope: Milestone 1 delivered active local Faster-Whisper recognition and a deterministic three-site periodontal engine. Milestone 2 builds the clinical voice intelligence layer above it: relevance filtering, sequence protection, context-aware disambiguation, negation scope, natural corrections with an append-only journal, noise robustness, speaker attribution, cadence-adaptive endpointing, full-mouth context recovery, dental terminology and accent handling, plus the evaluation harness that measures all of it.

## Milestone 1 — active local recognition

- [x] G0: this completion ledger states executable outcomes that can fail
  CHECK: node /home/adithyan/.claude/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=1b83816ddf3db89ce2a31a3a6e49a4a0a9d9f5e700761ed6e598381d81102d44; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G1: server audio framing, speech segmentation, backpressure, and session state pass deterministic tests
  CHECK: node scripts/verify-server-domain.mjs
  EXPECT: SERVER_DOMAIN_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ecde0efe478d5e2810c752f870faa68761a712dd95b4870679441874948951c2; exit=0; EXPECT=matched; output-sha256=59f26ce385f73062209a8551ac94cbdcdc81deddd425008cd54fa00d711efa61; output-bytes=125; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G2: the real local Faster-Whisper model loads and recognizes known spoken audio without a mock
  CHECK: uv run python scripts/verify_model_runtime.py
  EXPECT: ACTIVE_MODEL_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=3bcfca5b8d803c151dbdebb58e080f7fd5918a68d74ac668ec5724d823babf78; exit=0; EXPECT=matched; output-sha256=d48b3be2ee43c0d1a624b6a143ba7ae0c6b28c0dac757d9a0c2d118d332cc4c9; output-bytes=196; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G3: the FastAPI health and binary WebSocket protocol produce model, speech, partial, final, metrics, stop, and error messages correctly
  CHECK: node scripts/verify-asr-api.mjs
  EXPECT: ASR_API_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9531c5e1f2e3d5ce371f914a2fb11aaf6a2d36a30f95ceac178bfe44045e95eb; exit=0; EXPECT=matched; output-sha256=7c31b79e243adac0565242239f1b5441684b927a7510c57c0cfa7784bce65d54; output-bytes=647; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G4: the browser audio pipeline captures, resamples, batches, streams, reconnects, and cleans up microphone resources
  CHECK: node scripts/verify-browser-audio.mjs
  EXPECT: BROWSER_AUDIO_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ad9e84b4f051b01a9485e59a6f796bb42f3151c42d07e89b00597e03b1828fed; exit=0; EXPECT=matched; output-sha256=8cb52a674a14de63f2e89000ac0aceb1c08a94b8875d18622759b1c4cdfb4090; output-bytes=340; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G5: real ASR partial and final messages drive visible engine states and structured chart commits while the simulator remains available
  CHECK: node scripts/verify-active-workflow.mjs
  EXPECT: ACTIVE_WORKFLOW_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=2d12d0b84bb058363510f54a243fb497a1a0bb9258debb405e8ce3cb50241c8e; exit=0; EXPECT=matched; output-sha256=60be0bc9e6eaaf517592b84979a391c5ebb291e81c88b3644d7a45e9eddab8ef; output-bytes=345; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G6: the unified development command boots the backend and frontend, exposes model health, and shuts both down cleanly
  CHECK: node scripts/verify-dev-runtime.mjs
  EXPECT: DEV_RUNTIME_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=f05adda32e52d1328878a91b6ffde00829e67a9abcafd6f50ade4651863038a2; exit=0; EXPECT=matched; output-sha256=d01053c340ee329eb4fdc966e3fb401037ffa358bceb274af348155f23373006; output-bytes=24; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G7: existing periodontal parsing, corrections, negation, context, relevance, homophones, sequence protection, and latency behavior remain regression-safe
  CHECK: node scripts/verify-domain.mjs
  EXPECT: DOMAIN_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=def487a01bcfb155d4dd9d6e79398dd4ea4d890a7e69ef1a027ae3c924c7f00e; exit=0; EXPECT=matched; output-sha256=ab2ef5e94e342563c736e1c7a42527d377e07d8b10b93f750f2d89fd124e49e0; output-bytes=312; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G8: Python and TypeScript linting, strict type checks, tests, and the production frontend build pass
  CHECK: node scripts/verify-quality.mjs
  EXPECT: QUALITY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=b1ddb8f5d4e7d0b86385f5be053c2c3ebe01b24aff3dd7a2d1f82386c04af51e; exit=0; EXPECT=matched; output-sha256=f436159d8258ec0532dfa2a6c8a4d50b53e9d10147d13305d45fc8685d36a076; output-bytes=1715; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G9: the interface exposes accessible model-loading, offline, listening, processing, error-recovery, and fallback states
  CHECK: node scripts/verify-accessibility.mjs
  EXPECT: ACCESSIBILITY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9104c5b84b69b1795d5e365499e2af46220916b7bc236b5ee5c97b735952bfeb; exit=0; EXPECT=matched; output-sha256=39209370edec2f5dc2d79ffa61b1d9af5677711847c0ff0c535c59aab8afe6f0; output-bytes=349; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G10: setup, model operation, protocol, latency budget, observability, deployment, safety boundaries, and every later build-order capability have implementable architecture documentation
  CHECK: node scripts/verify-architecture.mjs
  EXPECT: ARCHITECTURE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=33c8bf77efb11b930ae52f9f5af964a2e3d98e3ab6513a43e13b344862ff4cf6; exit=0; EXPECT=matched; output-sha256=dcc27719cc8e1af625e78b946868477f1b4206543db90b41757a6a62734a4982; output-bytes=25; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

## Milestone 2 — clinical voice intelligence layer

- [x] G11: a versioned dental lexicon canonicalizes terminology, abbreviations, and recognizer confusions, and supplies recognizer hotwords
  CHECK: node scripts/verify-lexicon.mjs
  EXPECT: LEXICON_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9cb67461602585ea69b3ef59adb6ef88275ecd5e36c91c5897f2e6cb65f341b7; exit=0; EXPECT=matched; output-sha256=998e3d8d8cf4001a0d97c9bb202582369a6894176fea2286c641619578a73203; output-bytes=303; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G12: the relevance classifier keeps conversational, patient-directed, and assistant-directed speech out of the chart while still admitting terse clinical speech
  CHECK: node scripts/verify-relevance.mjs
  EXPECT: RELEVANCE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=5d5cd012caa8104c6a952e05cd685ae906127ce9aec16052cf4377b0bb460e19; exit=0; EXPECT=matched; output-sha256=5e692959e1bd79eed318f1fd2353e4e833f821abbb622225f4dedf77d1e9f999; output-bytes=305; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G13: the candidate lattice and context resolver map ambiguous homophones only onto interpretations the active clinical context permits
  CHECK: node scripts/verify-disambiguation.mjs
  EXPECT: DISAMBIGUATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=e1ca83e595d56c46b06990ce6c5723d23c0420dee35f158eeb041c9f711a4b68; exit=0; EXPECT=matched; output-sha256=130e060bee53c0f114d4ab39561c5fe409f655b5d6070a7abf598e268d42e78f; output-bytes=318; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G14: negation cues assign the correct polarity and scope across findings, conjunctions, and pauses
  CHECK: node scripts/verify-negation.mjs
  EXPECT: NEGATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=072fd3574753214cced450e9d6170aa85c2f43cfd5ca2ac3dba6519b35a4e309; exit=0; EXPECT=matched; output-sha256=ed2cc1509390d5341961d3dba24e9670e8d6f34a5ebbca80582e82531fbe07be; output-bytes=305; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G15: an append-only journal resolves immediate, targeted, and delayed corrections and supports undo and redo without hidden mutation
  CHECK: node scripts/verify-corrections.mjs
  EXPECT: CORRECTIONS_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=108087292cff8e8d23338d53bb0555a0a93bbace305144fc96b039e51bc8b040; exit=0; EXPECT=matched; output-sha256=c90c46666b49969392f1e4496f0758058c4035253c11368bd2a36f559db7d0ed; output-bytes=314; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G16: the sequence guard rejects inserted, dropped, and duplicated values atomically instead of shifting later sites
  CHECK: node scripts/verify-sequence-guard.mjs
  EXPECT: SEQUENCE_GUARD_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=a23005353040ea4f4569120cb4956aba243db966dad4d8f4cf1a91b26ca7b9b8; exit=0; EXPECT=matched; output-sha256=b1e55d5cd0fe6f8eba9a4f9bec369baa309a4edaa60f98659ed3629b23e9eb31; output-bytes=319; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G17: the full-mouth workflow state machine tracks position through skip, back, resume, and jumps, and rejects finals that observed a stale context
  CHECK: node scripts/verify-workflow-state.mjs
  EXPECT: WORKFLOW_STATE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=87b94d213e801728368d56cc13faf409d163b264056b492b15a8b81e985e034c; exit=0; EXPECT=matched; output-sha256=9a919bc50fc7a7fcde3ae86f0664fad7997db577b58857cf751685e27ad46836; output-bytes=316; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [ ] G18: speaker verification accepts the enrolled clinician and blocks unenrolled and unknown speakers from committing chart data
  CHECK: node scripts/verify-speaker.mjs
  EXPECT: SPEAKER_GATE_PASSED
  EVIDENCE: pending

- [x] G19: endpointing adapts to fast, slow, and uneven cadence inside safe bounds without clipping short utterances
  CHECK: node scripts/verify-cadence.mjs
  EXPECT: CADENCE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ee54c0302a5ad66a7c4da3c39a7af761307f9760013fb5223cd8268023c1cf13; exit=0; EXPECT=matched; output-sha256=e4744a59f5d47506587e835f7d28e48b1f5771f5d33dce48792b37e920bf30bd; output-bytes=118; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G20: the acoustic replay harness measures word error rate against synthesized operatory noise at fixed SNR bands and promotes a preprocessing profile only on measured improvement
  CHECK: uv run python scripts/evaluate_acoustic.py --gate
  EXPECT: ACOUSTIC_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=5a06b6ea41c264aa56af07554d4cd75ce8aef67e5534a15906d15255f22689a8; exit=0; EXPECT=matched; output-sha256=879b3121037a4d7949039441a6d856edd8f808d721b47ca6f6c1ccd84984b6e9; output-bytes=4567; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G21: the clinical evaluation harness measures exact match, false chart entry, site alignment error, correction success, and latency per cohort against declared thresholds
  CHECK: node scripts/evaluate-clinical.mjs --gate
  EXPECT: CLINICAL_EVAL_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=eff028e054339a79bc5f4866c9e797dd535323782d230bbb24f02b45b928cdad; exit=0; EXPECT=matched; output-sha256=4f56678456485efd1af19e03d4851066ae3f39ff3af0529ec4898fa6240e02e2; output-bytes=965; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G22: the assembled pipeline runs every stage in order, records a stage trace, and keeps parser-side latency inside the declared budget
  CHECK: node scripts/verify-pipeline.mjs
  EXPECT: PIPELINE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=5f923b1ebb5543511b23f51529dbb63011032ed7a3875e007cd6959c3c2931ad; exit=0; EXPECT=matched; output-sha256=c36f33a219883b7511161fb8d1fed9ffd3afc65c22e3a5f46cee200a1233548e; output-bytes=308; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G23: the interface exposes workflow position, pending confirmations, speaker attribution, undo and redo, and the decision trace accessibly
  CHECK: node scripts/verify-intelligence-ui.mjs
  EXPECT: INTELLIGENCE_UI_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=62fb668d91ac10a6f14808e30f360d379dbfa01d4eca8b21665d2e397bc62202; exit=0; EXPECT=matched; output-sha256=4e236c419f916529635f84a5ba6c55003909f26ee84200e4fd317a993100b577; output-bytes=352; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G24: runtime telemetry emits bounded, identifier-free counters and histograms over the health endpoint
  CHECK: node scripts/verify-telemetry.mjs
  EXPECT: TELEMETRY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=391bc00f3590e76484b41e9f350eff9e23984ab59b77a149507bd005871d1270; exit=0; EXPECT=matched; output-sha256=a3a401db07417ecda9b34d73addb01d64c7d92fb61c8f3eade160c5ce9357c03; output-bytes=648; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G25: setup, capability, evaluation, and safety documentation matches the delivered intelligence layer
  CHECK: node scripts/verify-documentation.mjs
  EXPECT: DOCUMENTATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=19a0cd1137bb98a8f1f6a522a8be8b55a9d7550a36183eae4606ac7bb5a363c1; exit=0; EXPECT=matched; output-sha256=cea4823b4682d434666fcd9ce41cc5057e7b1713953dcb358201c4f4d7eafb3c; output-bytes=26; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

## Milestone 3 — recognition that actually works

- [x] G26: the dental fixture manifest is well formed and every utterance has a cohort and expected outcome
  CHECK: node scripts/verify-fixture-capture.mjs --manifest
  EXPECT: FIXTURE_MANIFEST_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=b1320e35e4903f04b9d5d078c33bf496d5401ef5ae7d04551aa1123dd89d5958; exit=0; EXPECT=matched; output-sha256=18ac5c1c3252d319f06f3bc89f9c000033d4563f340a2b6c52cf6fa1fdb31443; output-bytes=29; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G27: recorded dental audio can be scored through the real clinical pipeline
  CHECK: node scripts/verify-dental-evaluation.mjs
  EXPECT: DENTAL_EVALUATION_BRIDGE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=089cb45438d63a0aa060630530097573d8ae965502130a5487c76e6f87450cfb; exit=0; EXPECT=matched; output-sha256=689d93667ec370dd2d1c996a725b3696abebfae3ea24a237f2173354d53383d1; output-bytes=32; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G28: every word the clinical grammars can emit exists in the recognizer lexicon, so no clinical term is silently unrecognizable
  CHECK: uv run python scripts/verify_grammar_lexicon.py
  EXPECT: GRAMMAR_LEXICON_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=a3f235fa2abce1ceb91cbd59ae17795ab4ea731d09cb451b2cc6b354f45473f8; exit=0; EXPECT=matched; output-sha256=d70a86fb831c31256ae5b52fb763c4a72fd9b8214de0fd459e556bd4b5ff30b0; output-bytes=244; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G29: grammar-constrained recognition beats the previous Whisper configuration on spoken dental phrases by the declared margin
  CHECK: uv run python scripts/evaluate_recognizers.py --gate
  EXPECT: RECOGNIZER_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9097f9ffb3766b3f76193a7c1c859d6c7883b7527d2dd2d7ef27fdc38152c0d7; exit=0; EXPECT=matched; output-sha256=6451d783fe37c99783df3e827060075f127ec368dea81c3659ce826b09082b47; output-bytes=304; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G30: the active clinical context selects the grammar, and speech outside it yields no clinical value instead of an invented one
  CHECK: uv run python scripts/verify_grammar_routing.py
  EXPECT: GRAMMAR_ROUTING_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=eb234aca0a5f5a828a5bcb9acaba3ac5f88ffb95507d88709c00731f58e5c04b; exit=0; EXPECT=matched; output-sha256=a8450fa69722d241c5570285f27d58f2908309da8facd3dd6ff4d99934980eac; output-bytes=302; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G31: speaker enrollment completes from one ordinary six-second take without raised voice
  CHECK: uv run python scripts/verify_enrollment.py
  EXPECT: ENROLLMENT_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=4a3607e2d03292388fdda1ef5b37bed4ddc5249d545c3ee96b1b514c0ab09a83; exit=0; EXPECT=matched; output-sha256=aba74203f8294ceb3e2334f7acfc26599c0d6e94638a42c027a1eacc60c10033; output-bytes=185; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G32: a half-second clinical utterance produces a speaker decision instead of being held as unknown
  CHECK: uv run python scripts/verify_short_verification.py
  EXPECT: SHORT_VERIFICATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=127441562232250a92f1f735d0c7dfe779d66150e47369438498889e5df7f4d4; exit=0; EXPECT=matched; output-sha256=0cab948ac07090086a8c8c8888f5dc86e2b78d6e485aa6232804cb594d11d378; output-bytes=301; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [ ] G33: the speaker thresholds sit inside a margin re-measured across the enrollment and verification durations the product actually uses
  CHECK: uv run python scripts/calibrate_speaker.py
  EXPECT: SPEAKER_CALIBRATION_OK
  EVIDENCE: pending

- [x] G34: setup, configuration, and evaluation documentation describes the recognizer routing and the measured accuracy
  CHECK: node scripts/verify-documentation.mjs
  EXPECT: DOCUMENTATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=19a0cd1137bb98a8f1f6a522a8be8b55a9d7550a36183eae4606ac7bb5a363c1; exit=0; EXPECT=matched; output-sha256=cea4823b4682d434666fcd9ce41cc5057e7b1713953dcb358201c4f4d7eafb3c; output-bytes=26; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

## Milestone 4 — recognition quality under real use

- [x] G35: no grammar forces a legitimate clinical word onto a different word, so narrowing can never substitute rather than bias
  CHECK: uv run python scripts/verify_no_forced_substitution.py
  EXPECT: NO_FORCED_SUBSTITUTION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=3ffcc6380d61ddc170afad66871b1d57819ea6bdb73a23762a428f57970d096d; exit=0; EXPECT=matched; output-sha256=85fb9a1e83d1d0f097175cbf3857bc00746625be0c12b2caedc695978be6b1f8; output-bytes=204; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G36: acoustically confusable clinical words are each recognized as themselves rather than as their competitor
  CHECK: uv run python scripts/verify_confusable_pairs.py
  EXPECT: CONFUSABLE_PAIRS_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=683ff138e92499bfdb3037b7aa6d4b6af29ab9edf97db5fcb9481c4cf1b6c245; exit=0; EXPECT=matched; output-sha256=a5098bee03416439f7946216c96a7ce917bcdc680df653a5687d6cb7e3525ac3; output-bytes=157; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G37: the recognizer offers alternatives for low-confidence words so the clinical context can resolve them
  CHECK: uv run python scripts/verify_alternatives.py
  EXPECT: ALTERNATIVES_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=15954a0c6eb1cbe30a6fdec21e17342e4cf1de2c986dd5e9cae8a51c124e33d9; exit=0; EXPECT=matched; output-sha256=f89c36c3a57bf6ba0d238631601b7e8c171f852bd6d4fedad5e82655ab76fff9; output-bytes=304; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G38: recognition of spoken dental phrases meets the raised accuracy bar end to end
  CHECK: uv run python scripts/evaluate_recognizers.py --gate
  EXPECT: RECOGNIZER_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9097f9ffb3766b3f76193a7c1c859d6c7883b7527d2dd2d7ef27fdc38152c0d7; exit=0; EXPECT=matched; output-sha256=90f9350df8c7ae932d3df9a30d9fb8e05fff7f0d4c3a372227648889da33a553; output-bytes=304; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G39: quiet speech is detected as speech, and room noise alone is not, without either being configured
  CHECK: uv run python scripts/verify_speech_detection.py
  EXPECT: SPEECH_DETECTION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=b7a59e212c7534087afe5d7103e797e6c339a77fae7537ba231071a86467a97b; exit=0; EXPECT=matched; output-sha256=db2c4c8196c574dabe7212d41290087951dddd6f0f839db9f97afe6d7ceaa84b; output-bytes=651; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

## Milestone 5 — automated loudspeaker fixture capture

- [x] G40: local TTS replay records every phrase through the production PCM worklet, adds noise only for the noise pass, rejects inaudible audio, cancels cleanly, and cannot overwrite human recordings
  CHECK: node scripts/verify-acoustic-replay.mjs
  EXPECT: ACOUSTIC_REPLAY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=8da742f594025ba4f0247b256c68470fd14cb0e910a0a7bdd6e741ccacf26052; exit=0; EXPECT=matched; output-sha256=b0f14cac386e28ade8ef0234b6c903231ea6b172686f39c83fedd46a6ada3103; output-bytes=28; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

- [x] G41: setup and evaluation documentation distinguishes loudspeaker replay from human clinical validation and gives an executable replay evaluation workflow
  CHECK: node scripts/verify-documentation.mjs
  EXPECT: DOCUMENTATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=19a0cd1137bb98a8f1f6a522a8be8b55a9d7550a36183eae4606ac7bb5a363c1; exit=0; EXPECT=matched; output-sha256=cea4823b4682d434666fcd9ce41cc5057e7b1713953dcb358201c4f4d7eafb3c; output-bytes=26; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=b6fef52e3a67/13 entries

ABANDON: G33 The speaker profile does not separate voices at the durations this product uses, so no threshold can satisfy this gate. Measured against a six-second enrollment: at 0.5 s the enrolled speaker scored 0.7662 while another voice scored 0.9627, an inverted margin of -0.1965; separation only appears around four seconds, and a rolling four-second window still leaves +0.0007 on clean single-speaker audio. The original +0.0507 margin was measured on 5.5 s against 5.5 s, which is not the comparison the product makes. G31 and G32 fix the two real defects (enrollment now completes from one ordinary take, short utterances now reach a decision) and both pass. Discrimination needs a trained speaker-embedding model behind the same interface; attribution stays off by default and ARCHITECTURE.md and EVALUATION.md both state that it does not work.

ABANDON: G18 This gate claims voice attribution accepts the enrolled clinician and blocks other speakers, and that claim is not true: the underlying discrimination does not exist at clinical utterance lengths, for the reasons recorded against G33. Its check re-runs the same calibration G33 abandons, so keeping it would assert the impossible twice, and narrowing its check to whatever still passes would be fitting the oracle to the outcome. The parts that do work remain gated elsewhere -- enrollment by G31, short-utterance decisions by G32, and the pipeline's hold-on-unknown behaviour by tests/server/test_speaker.py and tests/pipeline.test.ts under G8. Attribution stays off by default and the documentation states it does not work.
