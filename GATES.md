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
  EVIDENCE: automatic-evidence=v1; definition-sha256=ecde0efe478d5e2810c752f870faa68761a712dd95b4870679441874948951c2; exit=0; EXPECT=matched; output-sha256=f3fa7420e3fedafe82f924600f61a70df8a68d37dbbac6802f546f716e811251; output-bytes=273; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G2: the real local Faster-Whisper model loads and recognizes known spoken audio without a mock
  CHECK: uv run python scripts/verify_model_runtime.py
  EXPECT: ACTIVE_MODEL_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=3bcfca5b8d803c151dbdebb58e080f7fd5918a68d74ac668ec5724d823babf78; exit=0; EXPECT=matched; output-sha256=996be350c9a87699c4c859c55fa2a856fb53b7a2a14761880830346452592af2; output-bytes=184; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G3: the FastAPI health and binary WebSocket protocol produce model, speech, partial, final, metrics, stop, and error messages correctly
  CHECK: node scripts/verify-asr-api.mjs
  EXPECT: ASR_API_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9531c5e1f2e3d5ce371f914a2fb11aaf6a2d36a30f95ceac178bfe44045e95eb; exit=0; EXPECT=matched; output-sha256=f38f212e9dadaa46412546f18ba1166c5c6675bf2c86214ac2d7ce837bac798e; output-bytes=785; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G4: the browser audio pipeline captures, resamples, batches, streams, reconnects, and cleans up microphone resources
  CHECK: node scripts/verify-browser-audio.mjs
  EXPECT: BROWSER_AUDIO_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ad9e84b4f051b01a9485e59a6f796bb42f3151c42d07e89b00597e03b1828fed; exit=0; EXPECT=matched; output-sha256=94b7946e771fc0d32db6a56a7ef1b38954f28b51a82cada3eef8fde4ad9b7ffd; output-bytes=337; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G5: real ASR partial and final messages drive visible engine states and structured chart commits while the simulator remains available
  CHECK: node scripts/verify-active-workflow.mjs
  EXPECT: ACTIVE_WORKFLOW_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=2d12d0b84bb058363510f54a243fb497a1a0bb9258debb405e8ce3cb50241c8e; exit=0; EXPECT=matched; output-sha256=e12b2460982d717907ed7bd471520898dc8c353b114f7ec71b64d378baefd229; output-bytes=345; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G6: the unified development command boots the backend and frontend, exposes model health, and shuts both down cleanly
  CHECK: node scripts/verify-dev-runtime.mjs
  EXPECT: DEV_RUNTIME_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=f05adda32e52d1328878a91b6ffde00829e67a9abcafd6f50ade4651863038a2; exit=0; EXPECT=matched; output-sha256=d01053c340ee329eb4fdc966e3fb401037ffa358bceb274af348155f23373006; output-bytes=24; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G7: existing periodontal parsing, corrections, negation, context, relevance, homophones, sequence protection, and latency behavior remain regression-safe
  CHECK: node scripts/verify-domain.mjs
  EXPECT: DOMAIN_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=def487a01bcfb155d4dd9d6e79398dd4ea4d890a7e69ef1a027ae3c924c7f00e; exit=0; EXPECT=matched; output-sha256=d15189511f3278e854d5c1c9a8a143c2611540d0eff386ded10874c4ed5cc959; output-bytes=312; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G8: Python and TypeScript linting, strict type checks, tests, and the production frontend build pass
  CHECK: node scripts/verify-quality.mjs
  EXPECT: QUALITY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=b1ddb8f5d4e7d0b86385f5be053c2c3ebe01b24aff3dd7a2d1f82386c04af51e; exit=0; EXPECT=matched; output-sha256=aa0ceddc496f0a296b6affff84cea9c47f7e8f732834856f30ec41b23c22c588; output-bytes=2522; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G9: the interface exposes accessible model-loading, offline, listening, processing, error-recovery, and fallback states
  CHECK: node scripts/verify-accessibility.mjs
  EXPECT: ACCESSIBILITY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9104c5b84b69b1795d5e365499e2af46220916b7bc236b5ee5c97b735952bfeb; exit=0; EXPECT=matched; output-sha256=985876c69af1c05488d65b0eec9a52b18abb9fd94d4ae4b4f97519c8b4ad8f28; output-bytes=347; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G10: setup, model operation, protocol, latency budget, observability, deployment, safety boundaries, and every later build-order capability have implementable architecture documentation
  CHECK: node scripts/verify-architecture.mjs
  EXPECT: ARCHITECTURE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=33c8bf77efb11b930ae52f9f5af964a2e3d98e3ab6513a43e13b344862ff4cf6; exit=0; EXPECT=matched; output-sha256=dcc27719cc8e1af625e78b946868477f1b4206543db90b41757a6a62734a4982; output-bytes=25; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

## Milestone 2 — clinical voice intelligence layer

- [x] G11: a versioned dental lexicon canonicalizes terminology, abbreviations, and recognizer confusions, and supplies recognizer hotwords
  CHECK: node scripts/verify-lexicon.mjs
  EXPECT: LEXICON_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=9cb67461602585ea69b3ef59adb6ef88275ecd5e36c91c5897f2e6cb65f341b7; exit=0; EXPECT=matched; output-sha256=607c8b40e4e3cf642c66108c0bde4be4babf459363e8ec89460bf33732f5b178; output-bytes=303; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G12: the relevance classifier keeps conversational, patient-directed, and assistant-directed speech out of the chart while still admitting terse clinical speech
  CHECK: node scripts/verify-relevance.mjs
  EXPECT: RELEVANCE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=5d5cd012caa8104c6a952e05cd685ae906127ce9aec16052cf4377b0bb460e19; exit=0; EXPECT=matched; output-sha256=3f3f6310a03a5e34fb984080e2ecdcf9dddf6d3b777ea0082838852dae96751a; output-bytes=305; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G13: the candidate lattice and context resolver map ambiguous homophones only onto interpretations the active clinical context permits
  CHECK: node scripts/verify-disambiguation.mjs
  EXPECT: DISAMBIGUATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=e1ca83e595d56c46b06990ce6c5723d23c0420dee35f158eeb041c9f711a4b68; exit=0; EXPECT=matched; output-sha256=448b0084f0d8b016b0b1a8a86cafbab93ae2d8e4f1a94777bdfad06dbc912d7f; output-bytes=318; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G14: negation cues assign the correct polarity and scope across findings, conjunctions, and pauses
  CHECK: node scripts/verify-negation.mjs
  EXPECT: NEGATION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=072fd3574753214cced450e9d6170aa85c2f43cfd5ca2ac3dba6519b35a4e309; exit=0; EXPECT=matched; output-sha256=03ec29c4e402eea9d59d224434b015a18b8d4b428fde1a2cb4b7af1ae257d244; output-bytes=305; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G15: an append-only journal resolves immediate, targeted, and delayed corrections and supports undo and redo without hidden mutation
  CHECK: node scripts/verify-corrections.mjs
  EXPECT: CORRECTIONS_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=108087292cff8e8d23338d53bb0555a0a93bbace305144fc96b039e51bc8b040; exit=0; EXPECT=matched; output-sha256=ee6a3be1a3524192567b2adfb875acf758410627b455caea7c2cbc2030327d88; output-bytes=314; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G16: the sequence guard rejects inserted, dropped, and duplicated values atomically instead of shifting later sites
  CHECK: node scripts/verify-sequence-guard.mjs
  EXPECT: SEQUENCE_GUARD_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=a23005353040ea4f4569120cb4956aba243db966dad4d8f4cf1a91b26ca7b9b8; exit=0; EXPECT=matched; output-sha256=c12939efd1717e5e6f366db81e99370890a079c877b81ec47574b6afc22f8619; output-bytes=319; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G17: the full-mouth workflow state machine tracks position through skip, back, resume, and jumps, and rejects finals that observed a stale context
  CHECK: node scripts/verify-workflow-state.mjs
  EXPECT: WORKFLOW_STATE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=87b94d213e801728368d56cc13faf409d163b264056b492b15a8b81e985e034c; exit=0; EXPECT=matched; output-sha256=555960372b5e2231583e9ae91f05d64774b6ef7973b6eff0d498bacf480f364d; output-bytes=316; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G18: speaker verification accepts the enrolled clinician and blocks unenrolled and unknown speakers from committing chart data
  CHECK: node scripts/verify-speaker.mjs
  EXPECT: SPEAKER_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=7abc3e5a488ea0aa4384e34fcfa0116a8443809e91770796d09f7758681fef39; exit=0; EXPECT=matched; output-sha256=2c2e8bc0bc4ba122b9f8f93ef8f5153f95cfd100414566c760f2177612023408; output-bytes=472; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G19: endpointing adapts to fast, slow, and uneven cadence inside safe bounds without clipping short utterances
  CHECK: node scripts/verify-cadence.mjs
  EXPECT: CADENCE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ee54c0302a5ad66a7c4da3c39a7af761307f9760013fb5223cd8268023c1cf13; exit=0; EXPECT=matched; output-sha256=df55ede68753d464a1e1278c5d91934a7b75edb3f27c99d5db45df1ac8505426; output-bytes=239; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G20: the acoustic replay harness measures word error rate against synthesized operatory noise at fixed SNR bands and promotes a preprocessing profile only on measured improvement
  CHECK: uv run python scripts/evaluate_acoustic.py --gate
  EXPECT: ACOUSTIC_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=5a06b6ea41c264aa56af07554d4cd75ce8aef67e5534a15906d15255f22689a8; exit=0; EXPECT=matched; output-sha256=cc6cab3802f59ba82aee029fbff43b0ac705e60ede753d51703bf7a922ff2246; output-bytes=4567; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G21: the clinical evaluation harness measures exact match, false chart entry, site alignment error, correction success, and latency per cohort against declared thresholds
  CHECK: node scripts/evaluate-clinical.mjs --gate
  EXPECT: CLINICAL_EVAL_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=eff028e054339a79bc5f4866c9e797dd535323782d230bbb24f02b45b928cdad; exit=0; EXPECT=matched; output-sha256=b2319a17c32f8b992599c57f884d8203029b781ac5d020d38cdc4de8f151bae6; output-bytes=965; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G22: the assembled pipeline runs every stage in order, records a stage trace, and keeps parser-side latency inside the declared budget
  CHECK: node scripts/verify-pipeline.mjs
  EXPECT: PIPELINE_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=5f923b1ebb5543511b23f51529dbb63011032ed7a3875e007cd6959c3c2931ad; exit=0; EXPECT=matched; output-sha256=51c49e1c4b71cafcf99b378464c13c5d52d9dd0e3e967fc84c6b198ec185a7ec; output-bytes=308; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G23: the interface exposes workflow position, pending confirmations, speaker attribution, undo and redo, and the decision trace accessibly
  CHECK: node scripts/verify-intelligence-ui.mjs
  EXPECT: INTELLIGENCE_UI_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=62fb668d91ac10a6f14808e30f360d379dbfa01d4eca8b21665d2e397bc62202; exit=0; EXPECT=matched; output-sha256=ae4548cb82683a6563fe17bed0672ea60c35f1e09f7484afbbbf9c5ad98f260f; output-bytes=352; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G24: runtime telemetry emits bounded, identifier-free counters and histograms over the health endpoint
  CHECK: node scripts/verify-telemetry.mjs
  EXPECT: TELEMETRY_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=391bc00f3590e76484b41e9f350eff9e23984ab59b77a149507bd005871d1270; exit=0; EXPECT=matched; output-sha256=26aa5e5ae5f389bd05985ba4f249c0804aff8619d59f45cc7559707411014dc1; output-bytes=760; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

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
  EVIDENCE: automatic-evidence=v1; definition-sha256=9097f9ffb3766b3f76193a7c1c859d6c7883b7527d2dd2d7ef27fdc38152c0d7; exit=0; EXPECT=matched; output-sha256=83e5db8c1c26f01211cf4fbb88d96660a8601dec1b856636ee3fb40246f8cee5; output-bytes=304; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

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
  EVIDENCE: automatic-evidence=v1; definition-sha256=3ffcc6380d61ddc170afad66871b1d57819ea6bdb73a23762a428f57970d096d; exit=0; EXPECT=matched; output-sha256=85fb9a1e83d1d0f097175cbf3857bc00746625be0c12b2caedc695978be6b1f8; output-bytes=204; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

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
  EVIDENCE: automatic-evidence=v1; definition-sha256=9097f9ffb3766b3f76193a7c1c859d6c7883b7527d2dd2d7ef27fdc38152c0d7; exit=0; EXPECT=matched; output-sha256=c46533242e52ad27b404419fe42ee853e0270f66184a9830de964fbf57798152; output-bytes=304; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

- [x] G39: quiet speech is detected as speech, and room noise alone is not, without either being configured
  CHECK: uv run python scripts/verify_speech_detection.py
  EXPECT: SPEECH_DETECTION_GATE_PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=b7a59e212c7534087afe5d7103e797e6c339a77fae7537ba231071a86467a97b; exit=0; EXPECT=matched; output-sha256=db2c4c8196c574dabe7212d41290087951dddd6f0f839db9f97afe6d7ceaa84b; output-bytes=651; shell=/bin/sh; cwd=/home/adithyan/Documents/DSOLVE; path=635bb48c0f05/9 entries

ABANDON: G33 The speaker profile does not separate voices at the durations this product uses, so no threshold can satisfy this gate. Measured against a six-second enrollment: at 0.5 s the enrolled speaker scored 0.7662 while another voice scored 0.9627, an inverted margin of -0.1965; separation only appears around four seconds, and a rolling four-second window still leaves +0.0007 on clean single-speaker audio. The original +0.0507 margin was measured on 5.5 s against 5.5 s, which is not the comparison the product makes. G31 and G32 fix the two real defects (enrollment now completes from one ordinary take, short utterances now reach a decision) and both pass. Discrimination needs a trained speaker-embedding model behind the same interface; attribution stays off by default and ARCHITECTURE.md and EVALUATION.md both state that it does not work.
