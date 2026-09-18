# Current task — finish the latency-quality recognition milestone

Updated: 2026-09-18

## Objective

Finish and independently verify the low-latency local voice-perio recognition path.
It must improve perceived response time without weakening clinical accuracy or safety.
Terminal clinical text must remain local CUDA large-v3 Whisper. Grammar recognition may
only provide provisional endpoint hints; it may never replace a final transcript or write
a clinical record.

Target environment is the current offline-first 4 GB RTX 4060 deployment. Preserve browser
and legacy-client compatibility.

## Worktree safety

- Branch: main.
- Last pre-milestone commit: 99ac6a9 fix(asr): fit large-v3 GPU profile on 4GB cards.
- Earlier auto-charting commit: 1764d76 feat: add safe low-latency automatic charting.
- Current milestone changes are intentional and uncommitted. Preserve them. Never reset,
  checkout, broadly stash, or overwrite concurrent work.
- scratch/ is an untracked user directory. Never edit, remove, add, or commit it.
- git diff --check was clean at last inspection.
- Do not commit or push unless the user explicitly asks.

Expected milestone files include:
ARCHITECTURE.md, EVALUATION.md, README.md, docs/,
public/audio/pcm-capture-worklet.js,
scripts/verify_fast_endpoint.py, scripts/verify_latency_quality.py,
scripts/verify_live_recognizer.py, scripts/verify-competitive-latency.mjs,
scripts/verify-transport-contract.mjs,
server/app.py, server/audio.py, server/grammar_recognizer.py,
server/routed_recognizer.py, server/session.py, server/telemetry.py,
src/speech/protocol.ts, src/speech/useLocalAsr.ts,
tests/server/test_api.py, tests/server/test_audio.py, tests/server/test_session.py,
tests/speechAdapter.test.tsx, and tests/worklet.test.ts.

The correct server verifier is scripts/verify_fast_endpoint.py. Do not create similarly
named duplicate files.

## Implemented and verified browser transport

The browser leaf is complete, parent-reverified, released, and marked VERIFIED in the
Unlazy plan (leaf 1.1.2).

- PCM worklet batches default to 20 ms.
- Audio backlog is bounded; dropped ranges are ordered/coalesced and reported.
- Start handshake is required before sends. Context persists across reconnect, and
  reconnect/stop recovery is safe.
- Protocol handles endpoint, timing, audio-gap, and error metadata.
- Browser does not chart partial results; terminals still drive charting.
- The transport contract verifier has structural and behavioral negative controls.

Checks already passed:
Focused Vitest: 2 files / 21 tests.
Full Vitest: 21 files / 227 tests.
Typecheck, ESLint, production build.
node scripts/verify-transport-contract.mjs => TRANSPORT_CONTRACT_PASSED.

## Implemented server fast path — parent verification required

The server worker completed its leaf (1.1.1) but its result is not yet independently
accepted.

- Additive start/context controls carry stream and context identity.
- Finals carry streamId, utteranceId, transactionId, revision, original context version,
  lifecycle, recognition path, and timing.
- Endpoint is emitted before terminal Whisper decode.
- CUDA large-v3 terminal path remains Whisper. Grammar is strictly provisional and only
  supplies a semantic early-endpoint hint.
- audio_gap is validated fail-closed; telemetry, cancellation, queue, grammar-session, and
  state cleanup are covered.
- Legacy starts without streamId remain supported with null stream identity and deterministic
  legacy transaction IDs.
- Explicit CPU/AUTO clinical routing preserves its previous grammar fallback. CUDA large-v3
  does not.

The worker reported:
Focused server tests: 43 passed.
Full Python suite: 120 passed.
uv run --extra gpu python scripts/verify_fast_endpoint.py => FAST_ENDPOINT_GATE_PASSED.
ruff, mypy, and git diff --check passed.

Treat the report as a claim until the Unlazy acceptance procedure below is complete.

## Evidence/docs leaf — parent verification required

The evidence worker completed leaf 1.1.3. It changed:
scripts/verify_live_recognizer.py,
scripts/verify_latency_quality.py,
scripts/verify-competitive-latency.mjs,
docs/CARESTACK_LATENCY_GAP_ANALYSIS.md,
README.md, ARCHITECTURE.md, and EVALUATION.md.

It reports:
LATENCY_QUALITY_UNIT_PASSED.
COMPETITIVE_LATENCY_CONTRACT_PASSED.
ruff, py_compile, documentation, architecture, and timing-parser checks passed.

The GPU/live latency gate was intentionally not run. This is correct: run it only after
the server leaf integration is accepted, with no dev server contending for GPU.

Important integration requirement: endpoint/final payloads must include lastVoiceSample,
or an explicit equivalent offset. Strict live timing gates fail closed if this is absent;
legacy reporting may continue to function.

## Timing contract and baseline

Pre-fast-path baseline was captured with the development server stopped:

uv run --extra gpu python scripts/verify_live_recognizer.py --gate

service: large-v3 on cuda (int8_float16), ready
live: 138 recordings at 2x real time; chart 94.2% (98/104), false 1/29, split 1
endpoint -> final: p50 298 ms, p95 338 ms; decode p50 289 ms
partials 108, dropped 0
LIVE RECOGNIZER PASS large-v3 on cuda: chart 94.2%, p95 338 ms

Final contract:
- chart cases at least 98/104
- false entries at most 2
- splits at most 3
- endpoint-to-final p95 at most 450 ms
- semantic hangover at most 200 ms
- composed last-voice-to-final p95 at most 650 ms

The improvement is expected from replacing the earlier generic 520 ms trailing-silence
endpoint window with a safe grammar-supported 120–200 ms semantic hangover. Never use
grammar text to fabricate a faster final; final transcription must remain Whisper.

## CareStack-informed safety contract

Sources:
- https://carestack.zendesk.com/hc/en-us/articles/47790792843924-Voice-Perio-Perio-Charting-with-Voice-Commands
- https://carestack.zendesk.com/hc/en-us/articles/30313408675604-Explore-Perio-Charting
- https://carestack.com/en-GB/dental-software/features/voice-perio

Design requirements:
- CareStack documents click UI start/pause/resume/stop; retain our ordered direct stream
  protocol with reconnect-safe lifecycle.
- Its furcation/plaque instructions state omitted grade defaults to Grade 1. Our missing-grade
  handling must stay fail-closed/held/rejected, never defaulted.
- Its broader charting guide says completed charts cannot be deleted and edits are restricted to
  24 hours. Preserve our confirmation/review/transaction/audit path; do not silently commit.
- Any advantage claimed over CareStack beyond these source facts must be labelled inference.

## Exact Unlazy completion procedure

Active plan/ledgers are ignored intentionally under .unlazy/latency-quality/:
PLAN.md, GATES.md, gates/leaf-1.1.1.md, gates/leaf-1.1.2.md,
gates/leaf-1.1.3.md, and gates/node-1.1.md.

The ready-1 dispatch wave was sealed. Browser leaf 1.1.2 was returned, approved,
reverified, released, and marked VERIFIED. Server and evidence leaves must be accepted
in this order once their returns are recorded:

1. Record the return (replace leaf id for 1.1.3):

   uv run /home/adithyan/.codex/skills/unlazy/scripts/dispatch_check.py return \
     --scope latency-quality --wave ready-1 --leaf leaf-1.1.1

2. Read every new or changed verifier source completely before running it. Confirm it is
   safe and behavioral, with meaningful negative controls, rather than a text-only pass.

3. Approve and independently rerun the leaf ledger:

   uv run /home/adithyan/.codex/skills/unlazy/scripts/gate_check.py approve \
     .unlazy/latency-quality/gates/leaf-1.1.1.md
   uv run /home/adithyan/.codex/skills/unlazy/scripts/gate_check.py reverify \
     .unlazy/latency-quality/gates/leaf-1.1.1.md

4. Append the required status-log evidence, release its lease using dispatch_check.py,
   and use apply_patch to mark that leaf VERIFIED in PLAN.md.

5. After every leaf is released, add manual evidence for node N5 (lease release) and N6
   plus the evidence leaf manual gate (CareStack source review).

Then approve and reverify gates/node-1.1.md and the scoped root GATES.md. Read the CHECK
commands in each ledger before executing. The node requires child reverify, full quality,
GPU latency-quality, GPU noise rejection, lease evidence, and CareStack evidence.

If Unlazy instructions are not in context, read:
home/adithyan/.codex/skills/unlazy/SKILL.md
before manipulating the plan/gates/dispatch state.

## Integrated validation and handoff

Keep development server stopped until every GPU check completes. Never run GPU jobs in
parallel. The node ledger is authoritative; it should cover at least:

node scripts/verify-quality.mjs
uv run --extra gpu python scripts/verify_latency_quality.py --gate
uv run --extra gpu python scripts/verify_noise_rejection.py --gate

Record model profile, p50/p95, chart/noise/split metrics, and pass/fail evidence. If a
check fails, fix the product; never relax thresholds, remove negative controls, or
hard-code success.

After all checks pass:
1. Add a permanent acceptance gate to the project GATES.md for the latency-quality verifier
   (expected next ID G50), execute it, and record evidence. This prevents the only proof
   living in ignored Unlazy files.
2. Run git diff --check and review the complete diff for safety and compatibility.
3. Restart development only after GPU checks:
   PERIO_FIXTURE_CAPTURE=1 npm run dev
   Wait for a health response before reporting it running.
4. A known non-blocking Vite warning says Node 20.18.1 is below preferred 20.19+ / 22.12+.

## Non-negotiable safety constraints

- Terminal transcript: local CUDA large-v3 Whisper. Grammar never substitutes it.
- Only committed terminals may chart, through existing review/audit safeguards.
- audio_gap boundaries must be monotonic for the active stream. Malformed gaps must reject
  or safely reset, never masquerade as recognized audio.
- Preserve stream, utterance, transaction, revision, original-context, lifecycle,
  recognition-path, and timing identity end-to-end.
- Clinical defaults fail closed, especially omitted plaque/furcation grade.
- Preserve local/offline operation, bounded memory, reconnect safety, ordered context, and
  legacy client compatibility.
- Do not touch scratch/.

## Miscellaneous

The supplied AGENTS instructions referenced @RTK.md, but no RTK.md was found in or near
this repository. It is not a blocker. The graphify trigger is only /graphify, which was
not requested.

