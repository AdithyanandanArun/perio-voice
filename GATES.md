# Gates: clinical voice intelligence layer

OWNS: .gitignore, .python-version, ARCHITECTURE.md, EVALUATION.md, GATES.md, README.md, evaluation/**, package.json, package-lock.json, pyproject.toml, uv.lock, vite.config.ts, tsconfig.app.json, public/**, server/**, shared/**, src/**, tests/**, scripts/**

Scope: Milestone 1 delivered active local Faster-Whisper recognition and a deterministic three-site periodontal engine. Milestone 2 builds the clinical voice intelligence layer above it: relevance filtering, sequence protection, context-aware disambiguation, negation scope, natural corrections with an append-only journal, noise robustness, speaker attribution, cadence-adaptive endpointing, full-mouth context recovery, dental terminology and accent handling, plus the evaluation harness that measures all of it.

## Milestone 1 — active local recognition

- [x] G0: this completion ledger states executable outcomes that can fail
  CHECK: node /home/adithyan/.claude/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=1b83816ddf3db89ce2a31a3a6e49a4a0a9d9f5e700761ed6e598381d81102d44; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G1: server audio framing, speech segmentation, backpressure, and session state pass deterministic tests
  CHECK: node scripts/verify-server-domain.mjs
  EXPECT: SERVER_DOMAIN_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ecde0efe478d5e2810c752f870faa68761a712dd95b4870679441874948951c2; exit=0; EXPECT=matched; output-sha256=59f26ce385f73062209a8551ac94cbdcdc81deddd425008cd54fa00d711efa61; output-bytes=125; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G2: the real local Faster-Whisper model loads and recognizes known spoken audio without a mock
  CHECK: uv run python scripts/verify_model_runtime.py
  EXPECT: ACTIVE_MODEL_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=3bcfca5b8d803c151dbdebb58e080f7fd5918a68d74ac668ec5724d823babf78; exit=0; EXPECT=matched; output-sha256=faf210f5a1d3ecfbfbfeaeb55f4928e4d98625c9497d352211480c8ae62e4fba; output-bytes=194; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G3: the FastAPI health and binary WebSocket protocol produce model, speech, partial, final, metrics, stop, and error messages correctly
  CHECK: node scripts/verify-asr-api.mjs
  EXPECT: ASR_API_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9531c5e1f2e3d5ce371f914a2fb11aaf6a2d36a30f95ceac178bfe44045e95eb; exit=0; EXPECT=matched; output-sha256=014df8730d86528fffa1251fe1bfa75c13dff069b84a53eda5772201587d315b; output-bytes=647; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G4: the browser audio pipeline captures, resamples, batches, streams, reconnects, and cleans up microphone resources
  CHECK: node scripts/verify-browser-audio.mjs
  EXPECT: BROWSER_AUDIO_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ad9e84b4f051b01a9485e59a6f796bb42f3151c42d07e89b00597e03b1828fed; exit=0; EXPECT=matched; output-sha256=b607e9f08bb5d0915f74008dbbd1976d13d20edaa65361180fae57f53ecf75f5; output-bytes=340; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G5: real ASR partial and final messages drive visible engine states and structured chart commits while the simulator remains available
  CHECK: node scripts/verify-active-workflow.mjs
  EXPECT: ACTIVE_WORKFLOW_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=2d12d0b84bb058363510f54a243fb497a1a0bb9258debb405e8ce3cb50241c8e; exit=0; EXPECT=matched; output-sha256=ec1214fa762ea20a0c0a3b5bb908e0b121e27af8c9fad1270f36a0fee144fa99; output-bytes=345; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [ ] G6: the unified development command boots the backend and frontend, exposes model health, and shuts both down cleanly
  CHECK: node scripts/verify-dev-runtime.mjs
  EXPECT: DEV_RUNTIME_GATE_PASSED
  EVIDENCE: pending

- [x] G7: existing periodontal parsing, corrections, negation, context, relevance, homophones, sequence protection, and latency behavior remain regression-safe
  CHECK: node scripts/verify-domain.mjs
  EXPECT: DOMAIN_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=def487a01bcfb155d4dd9d6e79398dd4ea4d890a7e69ef1a027ae3c924c7f00e; exit=0; EXPECT=matched; output-sha256=7f095cf2b5a8070879a78d5e171bcf00034676dc09f718ef3a537ffd8566f0ba; output-bytes=312; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G8: Python and TypeScript linting, strict type checks, tests, and the production frontend build pass
  CHECK: node scripts/verify-quality.mjs
  EXPECT: QUALITY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=b1ddb8f5d4e7d0b86385f5be053c2c3ebe01b24aff3dd7a2d1f82386c04af51e; exit=0; EXPECT=matched; output-sha256=2adffa3a322ddc9168a132da6f71af0e6490f51319bf908275083f8890542d73; output-bytes=1900; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G9: the interface exposes accessible model-loading, offline, listening, processing, error-recovery, and fallback states
  CHECK: node scripts/verify-accessibility.mjs
  EXPECT: ACCESSIBILITY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9104c5b84b69b1795d5e365499e2af46220916b7bc236b5ee5c97b735952bfeb; exit=0; EXPECT=matched; output-sha256=1a3ce177e8dd17436d4d8e4a87ccfd753ce1ca1ac6c3a5f0a6d9069083540ce1; output-bytes=349; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G10: setup, model operation, protocol, latency budget, observability, deployment, safety boundaries, and every later build-order capability have implementable architecture documentation
  CHECK: node scripts/verify-architecture.mjs
  EXPECT: ARCHITECTURE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=33c8bf77efb11b930ae52f9f5af964a2e3d98e3ab6513a43e13b344862ff4cf6; exit=0; EXPECT=matched; output-sha256=dcc27719cc8e1af625e78b946868477f1b4206543db90b41757a6a62734a4982; output-bytes=25; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

## Milestone 2 — clinical voice intelligence layer

- [x] G11: a versioned dental lexicon canonicalizes terminology, abbreviations, and recognizer confusions, and supplies recognizer hotwords
  CHECK: node scripts/verify-lexicon.mjs
  EXPECT: LEXICON_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9cb67461602585ea69b3ef59adb6ef88275ecd5e36c91c5897f2e6cb65f341b7; exit=0; EXPECT=matched; output-sha256=cb401fee0a578490d231d98137022ee1b826cc535ff2dc4154bb6ab0cc7bfa53; output-bytes=303; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G12: the relevance classifier keeps conversational, patient-directed, and assistant-directed speech out of the chart while still admitting terse clinical speech
  CHECK: node scripts/verify-relevance.mjs
  EXPECT: RELEVANCE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=5d5cd012caa8104c6a952e05cd685ae906127ce9aec16052cf4377b0bb460e19; exit=0; EXPECT=matched; output-sha256=85ca23851a4d76f3def09948f8796409b038e34495e5da5aeb06752d36a7925c; output-bytes=305; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G13: the candidate lattice and context resolver map ambiguous homophones only onto interpretations the active clinical context permits
  CHECK: node scripts/verify-disambiguation.mjs
  EXPECT: DISAMBIGUATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=e1ca83e595d56c46b06990ce6c5723d23c0420dee35f158eeb041c9f711a4b68; exit=0; EXPECT=matched; output-sha256=e73015ed36fdcba6f9e9e797d05f7c17787b8a2efd4f5b5c477e177e277e7db6; output-bytes=318; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G14: negation cues assign the correct polarity and scope across findings, conjunctions, and pauses
  CHECK: node scripts/verify-negation.mjs
  EXPECT: NEGATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=072fd3574753214cced450e9d6170aa85c2f43cfd5ca2ac3dba6519b35a4e309; exit=0; EXPECT=matched; output-sha256=535b0ba3f1725e27cf03c1c4db92e7a42d218922abba26be8efa962233cc713b; output-bytes=305; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G15: an append-only journal resolves immediate, targeted, and delayed corrections and supports undo and redo without hidden mutation
  CHECK: node scripts/verify-corrections.mjs
  EXPECT: CORRECTIONS_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=108087292cff8e8d23338d53bb0555a0a93bbace305144fc96b039e51bc8b040; exit=0; EXPECT=matched; output-sha256=88b8b03ba4e3debd40b3d27fea7206be5946133b32ab72e2c5dc495c22b0f632; output-bytes=314; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G16: the sequence guard rejects inserted, dropped, and duplicated values atomically instead of shifting later sites
  CHECK: node scripts/verify-sequence-guard.mjs
  EXPECT: SEQUENCE_GUARD_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=a23005353040ea4f4569120cb4956aba243db966dad4d8f4cf1a91b26ca7b9b8; exit=0; EXPECT=matched; output-sha256=102d5032e60c96f6fd2e4de5e09ee86a8db183dd12d95385f2cfe9a8d8e8061b; output-bytes=319; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G17: the full-mouth workflow state machine tracks position through skip, back, resume, and jumps, and rejects finals that observed a stale context
  CHECK: node scripts/verify-workflow-state.mjs
  EXPECT: WORKFLOW_STATE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=87b94d213e801728368d56cc13faf409d163b264056b492b15a8b81e985e034c; exit=0; EXPECT=matched; output-sha256=930412f76fa0fa80cef996d0578e5323fd474437f51fc379c85b18536a43b695; output-bytes=316; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [ ] G18: speaker verification accepts the enrolled clinician and blocks unenrolled and unknown speakers from committing chart data
  CHECK: node scripts/verify-speaker.mjs
  EXPECT: SPEAKER_GATE_PASSED
  EVIDENCE: pending

- [x] G19: endpointing adapts to fast, slow, and uneven cadence inside safe bounds without clipping short utterances
  CHECK: node scripts/verify-cadence.mjs
  EXPECT: CADENCE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ee54c0302a5ad66a7c4da3c39a7af761307f9760013fb5223cd8268023c1cf13; exit=0; EXPECT=matched; output-sha256=a379cf2ea5db82ec9ffaaca1e4cc30346bc67a22b86e76b6334581427584f42a; output-bytes=118; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G20: the acoustic replay harness measures word error rate against synthesized operatory noise at fixed SNR bands and promotes a preprocessing profile only on measured improvement
  CHECK: uv run python scripts/evaluate_acoustic.py --gate
  EXPECT: ACOUSTIC_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=5a06b6ea41c264aa56af07554d4cd75ce8aef67e5534a15906d15255f22689a8; exit=0; EXPECT=matched; output-sha256=adf27539f3b4d42be1614cd4812dccc13e722762b1b1e56e3eb9b855088305af; output-bytes=4567; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G21: the clinical evaluation harness measures exact match, false chart entry, site alignment error, correction success, and latency per cohort against declared thresholds
  CHECK: node scripts/evaluate-clinical.mjs --gate
  EXPECT: CLINICAL_EVAL_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=eff028e054339a79bc5f4866c9e797dd535323782d230bbb24f02b45b928cdad; exit=0; EXPECT=matched; output-sha256=dc53e485e8e883425fd2e6deb937c3cad57dbf7b21c09be21274b57c3de3520a; output-bytes=965; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G22: the assembled pipeline runs every stage in order, records a stage trace, and keeps parser-side latency inside the declared budget
  CHECK: node scripts/verify-pipeline.mjs
  EXPECT: PIPELINE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=5f923b1ebb5543511b23f51529dbb63011032ed7a3875e007cd6959c3c2931ad; exit=0; EXPECT=matched; output-sha256=70c7eb8e41a32081e7a50f26b030cd29c97d77465708ef3752ae4d3d8cddd81c; output-bytes=308; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G23: the interface exposes workflow position, pending confirmations, speaker attribution, undo and redo, and the decision trace accessibly
  CHECK: node scripts/verify-intelligence-ui.mjs
  EXPECT: INTELLIGENCE_UI_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=62fb668d91ac10a6f14808e30f360d379dbfa01d4eca8b21665d2e397bc62202; exit=0; EXPECT=matched; output-sha256=c76f46f6ba7cdf7b044d8f59d84bfb046f858df65392163116fb2632a7e570ab; output-bytes=352; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G24: runtime telemetry emits bounded, identifier-free counters and histograms over the health endpoint
  CHECK: node scripts/verify-telemetry.mjs
  EXPECT: TELEMETRY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=391bc00f3590e76484b41e9f350eff9e23984ab59b77a149507bd005871d1270; exit=0; EXPECT=matched; output-sha256=42a822dbc20985af59af0eb1e26e9bd06ec9ceb3ab0643acddc12ca7d9f841ab; output-bytes=648; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G25: setup, capability, evaluation, and safety documentation matches the delivered intelligence layer
  CHECK: node scripts/verify-documentation.mjs
  EXPECT: DOCUMENTATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=19a0cd1137bb98a8f1f6a522a8be8b55a9d7550a36183eae4606ac7bb5a363c1; exit=0; EXPECT=matched; output-sha256=cea4823b4682d434666fcd9ce41cc5057e7b1713953dcb358201c4f4d7eafb3c; output-bytes=26; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

## Milestone 3 — recognition that actually works

- [x] G26: the dental fixture manifest is well formed and every utterance has a cohort and expected outcome
  CHECK: node scripts/verify-fixture-capture.mjs --manifest
  EXPECT: FIXTURE_MANIFEST_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=b1320e35e4903f04b9d5d078c33bf496d5401ef5ae7d04551aa1123dd89d5958; exit=0; EXPECT=matched; output-sha256=18ac5c1c3252d319f06f3bc89f9c000033d4563f340a2b6c52cf6fa1fdb31443; output-bytes=29; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G27: recorded dental audio can be scored through the real clinical pipeline
  CHECK: node scripts/verify-dental-evaluation.mjs
  EXPECT: DENTAL_EVALUATION_BRIDGE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=089cb45438d63a0aa060630530097573d8ae965502130a5487c76e6f87450cfb; exit=0; EXPECT=matched; output-sha256=689d93667ec370dd2d1c996a725b3696abebfae3ea24a237f2173354d53383d1; output-bytes=32; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G28: every word the clinical grammars can emit exists in the recognizer lexicon, so no clinical term is silently unrecognizable
  CHECK: uv run python scripts/verify_grammar_lexicon.py
  EXPECT: GRAMMAR_LEXICON_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=a3f235fa2abce1ceb91cbd59ae17795ab4ea731d09cb451b2cc6b354f45473f8; exit=0; EXPECT=matched; output-sha256=c0c0bf1550ccbebf9e90a53e0f3ca2dcbc0d24705aaedde2148166fc397a7c5c; output-bytes=244; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G29: grammar-constrained recognition beats the previous Whisper configuration on spoken dental phrases by the declared margin
  CHECK: uv run python scripts/evaluate_recognizers.py --gate
  EXPECT: RECOGNIZER_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9097f9ffb3766b3f76193a7c1c859d6c7883b7527d2dd2d7ef27fdc38152c0d7; exit=0; EXPECT=matched; output-sha256=83bff16f8e1c7b5ed99cb72312f96cbdc127a546fe39dfc3f31eba47b2bef689; output-bytes=455; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G30: the active clinical context selects the grammar, and speech outside it yields no clinical value instead of an invented one
  CHECK: uv run python scripts/verify_grammar_routing.py
  EXPECT: GRAMMAR_ROUTING_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=eb234aca0a5f5a828a5bcb9acaba3ac5f88ffb95507d88709c00731f58e5c04b; exit=0; EXPECT=matched; output-sha256=a8450fa69722d241c5570285f27d58f2908309da8facd3dd6ff4d99934980eac; output-bytes=302; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G31: speaker enrollment completes from one ordinary six-second take without raised voice
  CHECK: uv run python scripts/verify_enrollment.py
  EXPECT: ENROLLMENT_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=4a3607e2d03292388fdda1ef5b37bed4ddc5249d545c3ee96b1b514c0ab09a83; exit=0; EXPECT=matched; output-sha256=aba74203f8294ceb3e2334f7acfc26599c0d6e94638a42c027a1eacc60c10033; output-bytes=185; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G32: a half-second clinical utterance produces a speaker decision instead of being held as unknown
  CHECK: uv run python scripts/verify_short_verification.py
  EXPECT: SHORT_VERIFICATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=127441562232250a92f1f735d0c7dfe779d66150e47369438498889e5df7f4d4; exit=0; EXPECT=matched; output-sha256=0cab948ac07090086a8c8c8888f5dc86e2b78d6e485aa6232804cb594d11d378; output-bytes=301; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [ ] G33: the speaker thresholds sit inside a margin re-measured across the enrollment and verification durations the product actually uses
  CHECK: uv run python scripts/calibrate_speaker.py
  EXPECT: SPEAKER_CALIBRATION_OK
  EVIDENCE: pending

- [x] G34: setup, configuration, and evaluation documentation describes the recognizer routing and the measured accuracy
  CHECK: node scripts/verify-documentation.mjs
  EXPECT: DOCUMENTATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=19a0cd1137bb98a8f1f6a522a8be8b55a9d7550a36183eae4606ac7bb5a363c1; exit=0; EXPECT=matched; output-sha256=cea4823b4682d434666fcd9ce41cc5057e7b1713953dcb358201c4f4d7eafb3c; output-bytes=26; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

## Milestone 4 — recognition quality under real use

- [x] G35: no grammar forces a legitimate clinical word onto a different word, so narrowing can never substitute rather than bias
  CHECK: uv run python scripts/verify_no_forced_substitution.py
  EXPECT: NO_FORCED_SUBSTITUTION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=3ffcc6380d61ddc170afad66871b1d57819ea6bdb73a23762a428f57970d096d; exit=0; EXPECT=matched; output-sha256=1d4d1916e3646d86d32f74ce56192f8520f17ac07d69d8a7c8188efc88920e4f; output-bytes=204; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G36: acoustically confusable clinical words are each recognized as themselves rather than as their competitor
  CHECK: uv run python scripts/verify_confusable_pairs.py
  EXPECT: CONFUSABLE_PAIRS_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=683ff138e92499bfdb3037b7aa6d4b6af29ab9edf97db5fcb9481c4cf1b6c245; exit=0; EXPECT=matched; output-sha256=a5098bee03416439f7946216c96a7ce917bcdc680df653a5687d6cb7e3525ac3; output-bytes=157; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G37: the recognizer offers alternatives for low-confidence words so the clinical context can resolve them
  CHECK: uv run python scripts/verify_alternatives.py
  EXPECT: ALTERNATIVES_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=15954a0c6eb1cbe30a6fdec21e17342e4cf1de2c986dd5e9cae8a51c124e33d9; exit=0; EXPECT=matched; output-sha256=f89c36c3a57bf6ba0d238631601b7e8c171f852bd6d4fedad5e82655ab76fff9; output-bytes=304; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G38: recognition of spoken dental phrases meets the raised accuracy bar end to end
  CHECK: uv run python scripts/evaluate_recognizers.py --gate
  EXPECT: RECOGNIZER_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9097f9ffb3766b3f76193a7c1c859d6c7883b7527d2dd2d7ef27fdc38152c0d7; exit=0; EXPECT=matched; output-sha256=3d9e00e28a570fb1f055ec1f12eb80c57aa0f2d4b18c17066216dcb735e37a88; output-bytes=455; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G39: quiet speech is detected as speech, and room noise alone is not, without either being configured
  CHECK: uv run python scripts/verify_speech_detection.py
  EXPECT: SPEECH_DETECTION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=b7a59e212c7534087afe5d7103e797e6c339a77fae7537ba231071a86467a97b; exit=0; EXPECT=matched; output-sha256=db2c4c8196c574dabe7212d41290087951dddd6f0f839db9f97afe6d7ceaa84b; output-bytes=651; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

## Milestone 5 — automated loudspeaker fixture capture

- [x] G40: local TTS replay records every phrase through the production PCM worklet, adds noise only for the noise pass, rejects inaudible audio, cancels cleanly, and cannot overwrite human recordings
  CHECK: node scripts/verify-acoustic-replay.mjs
  EXPECT: ACOUSTIC_REPLAY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=8da742f594025ba4f0247b256c68470fd14cb0e910a0a7bdd6e741ccacf26052; exit=0; EXPECT=matched; output-sha256=b0f14cac386e28ade8ef0234b6c903231ea6b172686f39c83fedd46a6ada3103; output-bytes=28; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G41: setup and evaluation documentation distinguishes loudspeaker replay from human clinical validation and gives an executable replay evaluation workflow
  CHECK: node scripts/verify-documentation.mjs
  EXPECT: DOCUMENTATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=19a0cd1137bb98a8f1f6a522a8be8b55a9d7550a36183eae4606ac7bb5a363c1; exit=0; EXPECT=matched; output-sha256=cea4823b4682d434666fcd9ce41cc5057e7b1713953dcb358201c4f4d7eafb3c; output-bytes=26; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

## Milestone 6 — high-accuracy recognition on the GPU

- [x] G42: the service runs large-v3 on the GPU when one is usable, keeps the CPU recognizer otherwise, and lets any explicit ASR_* setting win
  CHECK: uv run --extra gpu pytest -q tests/server/test_config.py
  EXPECT: /\b5 passed\b/
  EVIDENCE: automatic-evidence=v1; definition-sha256=16a45d569adc5882c3f110b4bc624d9cf33a15d8b23f3d1a68b74cce2c39c022; exit=0; EXPECT=matched; output-sha256=ad430bcd751b836a91fab4ff65c168e7e4f252c79243c40745308b866b554cb7; output-bytes=98; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [ ] G43: the shipped recognizer (large-v3 with the shared example prompt) reaches 90% chart exact match on every replay recording with at most 2 false chart entries, beats the grammar recognizer it replaced by 25 points, and decodes at p95 within 700 ms
  CHECK: uv run --extra gpu python scripts/bakeoff.py --gate
  EXPECT: BAKEOFF GATE PASS shipped
  EVIDENCE: pending

- [ ] G44: streamed through the running service over /ws/asr as the browser streams them, the replay recordings keep 90% chart exact match with at most 2 false entries and 3 split utterances, and a final arrives within 700 ms of the endpoint at p95, on large-v3 on the GPU
  CHECK: uv run --extra gpu python scripts/verify_live_recognizer.py --gate
  EXPECT: LIVE RECOGNIZER PASS large-v3 on cuda
  EVIDENCE: pending

- [ ] G46: operatory noise bursts and saturated captures never become text on the shipped recognizer, on noise realizations the thresholds were not calibrated on, and removing the Silero check lets clinical-looking text through
  CHECK: uv run --extra gpu python scripts/verify_noise_rejection.py
  EXPECT: NOISE_REJECTION_GATE_PASSED
  EVIDENCE: pending

- [x] G45: setup, configuration, and evaluation documentation describes the GPU recognizer, how it is enabled, what was measured, and that the replay recordings are one synthetic voice
  CHECK: node scripts/verify-documentation.mjs
  EXPECT: DOCUMENTATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=19a0cd1137bb98a8f1f6a522a8be8b55a9d7550a36183eae4606ac7bb5a363c1; exit=0; EXPECT=matched; output-sha256=cea4823b4682d434666fcd9ce41cc5057e7b1713953dcb358201c4f4d7eafb3c; output-bytes=26; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

## Milestone 7 — safe, low-latency automatic charting

- [x] G47: semicolon- or newline-delimited periodontal dictation becomes an atomic multi-station chart only when every clause explicitly names one tooth and surface, completely parses, and passes the existing relevance, sequence, correction, and staleness guards
  CHECK: node scripts/verify-auto-chart.mjs
  EXPECT: AUTO_CHART_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=3ae2ba78dfae8ecd1b8b8f5ed0b2633a1a4425e9b91b9cc6a3d550c8fd5de784; exit=0; EXPECT=matched; output-sha256=b2ea95f5c12f10a3d49b1812631dea79b474b581ba668f2aa8df77f2f7423af1; output-bytes=309; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G48: the automatic-chart planner rejects malformed, ambiguous, conversational, out-of-range, and partially applicable batches without changing a single chart record, journal entry, or clinical context
  CHECK: node scripts/verify-auto-chart-safety.mjs
  EXPECT: AUTO_CHART_SAFETY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ff62d374650d8850e64703b6d7888e85fbecfc02887bdce58336335bb0db95c8; exit=0; EXPECT=matched; output-sha256=6dd4908f0e817b992628e62300e68da4fca65c12c149502688906ee6b8e45df7; output-bytes=353; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G49: automatic charting is wired into both ASR finals and the labelled simulator control, exposes its safety contract accessibly, and keeps p95 deterministic planning time below 5 ms
  CHECK: node scripts/verify-auto-chart-ui.mjs
  EXPECT: AUTO_CHART_UI_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=6f02c144c99a81653d23a2b16182a9f84af7255c3b48a4575d453522e0957c97; exit=0; EXPECT=matched; output-sha256=b513e4906e4cdf553fce7b240df15615c1e18e3d494a1ebe5f78fee6114c5724; output-bytes=316; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

## Milestone 8 — cloud streaming recognition with a local fallback

- [ ] G50: Deepgram nova-3-medical, decoding every replay recording, reaches at least 94/104 chart cases with at most 2 false chart entries through the real clinical pipeline
  CHECK: uv run python scripts/evaluate_cloud.py --gate
  EXPECT: CLOUD_ACCURACY_GATE_PASSED

- [ ] G51: streamed through the running service's cloud engine at real time, the replay recordings reach at least 94/104 chart cases with at most 2 false entries and 3 splits, and the time from the last voiced audio sent to the final arriving at the client is under 1000 ms at p95
  CHECK: uv run python scripts/verify_live_recognizer.py --engine cloud --gate
  EXPECT: LIVE RECOGNIZER PASS nova-3-medical

- [ ] G52: when the cloud is unreachable, rejects the key, or times out, the service finishes the utterance on the local recognizer, reports the fallback, and charts nothing from a failed or partial cloud result
  CHECK: uv run pytest -q tests/server/test_cloud_recognizer.py
  EXPECT: /\b([6-9]|\d{2,}) passed\b/

- [ ] G53: operatory noise bursts and saturated captures never become text on the cloud engine, and removing the speech checks is shown to matter or shown unnecessary with evidence
  CHECK: uv run python scripts/verify_noise_rejection.py --engine cloud
  EXPECT: NOISE_REJECTION_GATE_PASSED

- [ ] G54: the API key cannot reach git -- .env is ignored and untracked, and no tracked file contains the configured key
  CHECK: node scripts/verify-secrets.mjs
  EXPECT: SECRETS_GATE_PASSED

## Milestone 9 — clinic-ready interface

- [x] G55: the core relevance behaviour is balanced -- confidently non-chartable speech never charts, uncertain clinical speech charts without a confirmation hold, there is no relevance or continuous-charting toggle, continuous charting is always on, and requiring the enrolled clinician defaults off
  CHECK: npm run test:run -- tests/relevanceMode.test.ts
  EXPECT: /Tests\s+([6-9]|\d{2,}) passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=92d486a164909dc05416d31280186d81de294fb47cf1c3d82ff360e0f1096b92; exit=0; EXPECT=matched; output-sha256=ef6d58f10b998614732e716d9103ee7934f2a8ff9a1b30835207e0a463c857fb; output-bytes=290; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G56: the interface has three pages -- Profile (voice enrollment, account details, dark theme, enrolled-clinician switch), Perio test (live charting, latency) and Graph -- reachable by navigation and by URL, and the dark theme applies and persists
  CHECK: npm run test:run -- tests/pages.test.tsx
  EXPECT: /Tests\s+([6-9]|\d{2,}) passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=2ad5ea134baac4d587459915643abac375a84720daa9e0c779e7a2e98d9529c4; exit=0; EXPECT=matched; output-sha256=89ba1930fdf1b9ff1dd46e687ac7889e0c65d0a3e4894bd767432cb269b7e1d7; output-bytes=286; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G57: the Perio test page shows a 2D chart of all 32 teeth whose status (active, charted, pocket severity, bleeding, missing) follows the live chart
  CHECK: npm run test:run -- tests/toothChart.test.tsx
  EXPECT: /Tests\s+([5-9]|\d{2,}) passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=ff8d5cf6059e1c4f4828d5b530a8ae11c7a4bdb2fd4bc4f52f04eacedc09fcd6; exit=0; EXPECT=matched; output-sha256=0a2e2a6ab3ebb08793c062124224d668b322d5b0729c717e6e9761b22f105ef0; output-bytes=289; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G58: the Graph page charts the exam and exports an .xlsx clinical perio chart -- one row per tooth with six probing depths, recession, CAL, bleeding, suppuration, plaque, mobility and furcation -- that parses back to the charted values
  CHECK: npm run test:run -- tests/perioExport.test.ts
  EXPECT: /Tests\s+([5-9]|\d{2,}) passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=ec32d760f455a22a1f40ae7925158608833c2dbe61b76da3c468812ce6bff558; exit=0; EXPECT=matched; output-sha256=ead4c80b6721ea382a75382e6d75395bf6dc2af0ba48990a3c35b2ff7d911382; output-bytes=286; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G59: saying "pause" stops continuous charting and "start" resumes it, each recorded in the history with its trace, while "start over" still repeats the sequence and "resume" still returns to a skipped tooth
  CHECK: npm run test:run -- tests/voiceContinuous.test.ts
  EXPECT: /Tests\s+([5-9]|\d{2,}) passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=e14d184de310600ffd1eb166a916c5a0d060e966df5b1d1fae6d0885210051d5; exit=0; EXPECT=matched; output-sha256=66059d02db238fe497238659aad7822aadc36d418c08f4327127156766f40551; output-bytes=292; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [ ] G60: the full-mouth order is every buccal surface first -- upper 1 to 16, then lower 17 to 32 -- and then every lingual surface in the same sweep, and continuous charting, "next tooth", skip and back all follow it
  CHECK: npm run test:run -- tests/stationOrder.test.ts
  EXPECT: /Tests\s+([5-9]|\d{2,}) passed/

- [ ] G61: the 2D chart shows 64 surface cells -- a buccal panel and a lingual panel, each with upper 1-16 and lower 32-17 -- where the active surface, each surface's own pocket severity and bleeding, and skipped teeth follow the live chart
  CHECK: npm run test:run -- tests/toothChart.test.tsx
  EXPECT: /Tests\s+([8-9]|\d{2,}) passed/

- [ ] G62: a new exam starts at the first station of the charting sweep (tooth 1 buccal), derived from the station order, while the evaluation corpora keep the tooth-14 start they were authored at, so their scores keep their meaning
  CHECK: npm run test:run -- tests/initialStation.test.ts
  EXPECT: /Tests\s+([3-9]|\d{2,}) passed/

- [ ] G63: navigation phrases ("go/move/jump/switch/take me to tooth X", with and without a surface or following values) move to the tooth and never chart the "to" as a 2, while "to" inside a measurement sequence still reads as 2
  CHECK: npm run test:run -- tests/navigationTo.test.ts
  EXPECT: /Tests\s+([6-9]|\d{2,}) passed/

ABANDON: G33 The speaker profile does not separate voices at the durations this product uses, so no threshold can satisfy this gate. Measured against a six-second enrollment: at 0.5 s the enrolled speaker scored 0.7662 while another voice scored 0.9627, an inverted margin of -0.1965; separation only appears around four seconds, and a rolling four-second window still leaves +0.0007 on clean single-speaker audio. The original +0.0507 margin was measured on 5.5 s against 5.5 s, which is not the comparison the product makes. G31 and G32 fix the two real defects (enrollment now completes from one ordinary take, short utterances now reach a decision) and both pass. Discrimination needs a trained speaker-embedding model behind the same interface; attribution stays off by default and ARCHITECTURE.md and EVALUATION.md both state that it does not work.

ABANDON: G18 This gate claims voice attribution accepts the enrolled clinician and blocks other speakers, and that claim is not true: the underlying discrimination does not exist at clinical utterance lengths, for the reasons recorded against G33. Its check re-runs the same calibration G33 abandons, so keeping it would assert the impossible twice, and narrowing its check to whatever still passes would be fitting the oracle to the outcome. The parts that do work remain gated elsewhere -- enrollment by G31, short-utterance decisions by G32, and the pipeline's hold-on-unknown behaviour by tests/server/test_speaker.py and tests/pipeline.test.ts under G8. Attribution stays off by default and the documentation states it does not work.
