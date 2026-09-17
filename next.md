# Fix recognition quality

## Context

The voice-to-text is bad in real use, while the repo's own harness reports word
error rate 0.000. Both are true, and the gap between them is the actual problem:
**nothing in this project has ever measured recognition of dental speech.**

- The acoustic harness uses `tests/fixtures/jfk.flac` — one 11-second political
  speech excerpt.
- The clinical harness (`evaluation/corpus/clinical.json`) supplies *transcripts*
  and bypasses the recognizer entirely.
- The product recognizes 0.5–2 s utterances of digits and clinical terms.

So the harness cannot see the failure. Twice in the previous session a confident
conclusion drawn from that fixture turned out to be measurement noise. The plan
therefore makes the domain measurable first, then applies fixes in order of the
evidence behind them.

Everything below labelled *measured* was measured on this machine
(16-thread i7-13620H, CPU only) during planning.

### What was measured

| model | beam | clean WER | mean WER (clean + suction/handpiece/babble @10 and 0 dB) | decode per utterance |
|---|---|---|---|---|
| tiny.en | 1 | 0.000 | **0.195** ← today | ~150 ms |
| tiny.en | 5 | 0.000 | 0.143 | ~185 ms |
| base.en | 1 | 0.045 | 0.045 | ~295 ms |
| **base.en** | **5** | **0.000** | **0.045** | **~295 ms** ← chosen |
| small.en | 1 | 0.000 | 0.000 | ~900 ms |

Decode time is **flat with utterance length** (0.5 s and 11 s cost the same),
because Whisper always runs a fixed 30-second encoder window.

Other findings:

- **`no_speech_prob` cleanly separates non-speech from speech** and we discard
  it today. Real speech 0.018–0.504; silence, room hiss, suction and handpiece
  0.681–0.964. `avg_logprob` does **not** separate them (room hiss scored −0.180,
  better than real speech at −0.873), so the gate must use `no_speech_prob`.
- **Short-utterance hallucination is model-independent.** A 0.4 s clip produces
  `'Bye bye.'`, `'life.'`, `'You'` on tiny.en, base.en and small.en alike.
- **`initial_prompt` corrupts short utterances** consistently across models
  (`'My f***.'`, `'My fellow American'` where unprompted gives the correct
  `'my fellow Americans'`). Its apparent benefit in noise is 1–2 word errors on a
  22-word fixture — inside the fixture's resolution, so not evidence.
- **`hotwords` (available in faster-whisper 1.2.1) measured *worse*** than both
  alternatives here. It is not the drop-in fix it looks like.
- **The capture worklet has no anti-aliasing filter.**
  `public/audio/pcm-capture-worklet.js` decimates 48 kHz → 16 kHz by linear
  interpolation, so everything above 8 kHz folds into the speech band. This is
  objectively wrong; its measured effect on this fixture was inside noise. Fix it
  as correctness, not as a promised win.
- **The energy VAD is mis-tuned.** The 10th percentile of frame RMS during real
  continuous speech is 0.0090, below the `ASR_VAD_RMS_THRESHOLD` of 0.012, so the
  quietest tenth of genuine speech is classified as silence. A fixed absolute
  threshold also cannot adapt to microphone gain.
- **Temperature fallback is disabled.** `server/recognizer.py` pins
  `temperature=0.0`, which switches off Whisper's own retry-on-bad-decode.

### The GPU

The RTX 4060 is not visible to the OS right now: no `/dev/nvidia*` nodes, only
Intel UHD on the PCI bus, and `ctranslate2.get_cuda_device_count()` returns 0.
Enabling it is a system task (hybrid-graphics switching plus a CUDA-enabled
CTranslate2 and cuDNN), not a repo change. This plan makes device, model, compute
type and beam width configuration, and documents the profile to flip once the GPU
is live — at which point `small.en` on CUDA float16 is likely both faster than
today's CPU `tiny.en` **and** the zero-WER option, and should be re-measured
rather than assumed.

---

## Phase 1 — Make the domain measurable

Nothing after this phase should be tuned without it.

### 1.1 Fixture recording mode

Record through the **real capture path** — `getUserMedia` → the worklet → 16 kHz
PCM16 — so the fixture also captures capture-path defects. A Python recording
script would miss exactly the bugs we are hunting.

- **`src/components/FixtureRecorder.tsx`** — dev-only panel, mounted in
  `src/App.tsx` behind `import.meta.env.DEV && new URLSearchParams(location.search).has('record')`,
  so production is untouched. It walks a phrase list, records each, and posts it.
  Reuse the existing `captureSeconds` helper already in
  `src/speech/useLocalAsr.ts` (written for speaker enrolment) rather than adding a
  second capture path — lift it into `src/speech/capture.ts` and import it from
  both.
- **`evaluation/fixtures/dental/phrases.json`** — ~60 prompts covering every
  cohort in `evaluation/corpus/clinical.json`, each with its expected structured
  outcome. Critically, include **non-chartable phrases** ("can you pass me that",
  "okay this looks fine") so the *acoustic* false-entry rate becomes measurable,
  not just the transcript-level one.
- **`POST /api/fixture`** in `server/app.py` — accepts raw PCM16 plus a phrase id,
  writes `evaluation/fixtures/dental/<id>.wav`. Gate it behind a
  `PERIO_FIXTURE_CAPTURE=1` env check so it cannot exist in a normal run. Reuse
  `decode_pcm16` from `server/audio.py`.
- Record **two passes**: one quiet, one with operatory noise playing from a
  speaker. The second is what makes the noise numbers real rather than synthetic.
- `evaluation/fixtures/dental/` goes in `.gitignore` — it is voice data. Commit
  `phrases.json` and the resulting metrics, never the audio.

### 1.2 End-to-end evaluation

Two stages, reusing both existing harnesses rather than writing a third.

- **`scripts/evaluate_dental.py`** — decodes every fixture wav with the configured
  model and writes `transcripts.json` (transcript, `no_speech_prob`,
  `avg_logprob`, decode ms per phrase). Reuse `word_error_rate` from
  `evaluation/wer.py`.
- **`scripts/evaluate-clinical.mjs --transcripts <file>`** — a new input mode that
  feeds those real transcripts through the real pipeline via the existing
  `loadDomain()` bundler in `scripts/lib/domain.mjs`, and reports the same
  metrics it already computes: clinical exact match, false chart entry rate, site
  alignment error.

That second number — *spoken phrase → correct chart entry* — is the one that
matters and the one nothing currently reports.

**Gate:** new `G26`, with the honest threshold set from the first baseline run
rather than aspirationally.

---

## Phase 2 — Recognition fixes

Apply in this order; each is independently revertable.

### 2.1 Model and decoding — `server/config.py`, `server/recognizer.py`

- Default `ASR_MODEL` from `tiny.en` to **`base.en`**.
- Add `ASR_BEAM_SIZE` (default **5**) and thread it through `transcribe`.
- **Remove the `temperature=0.0` pin** so Whisper's temperature fallback works
  again; keep `condition_on_previous_text=False`.
- Document the measured trade-off table in `README.md` under Configuration, plus
  the CUDA profile (`ASR_DEVICE=cuda`, `ASR_COMPUTE_TYPE=float16`,
  `ASR_MODEL=small.en`) marked explicitly as *unmeasured on this machine*.

### 2.2 Reject what Whisper says is not speech — `server/recognizer.py`, `session.py`

The single highest-value fix after the model, and it is why handpiece noise
currently becomes the word "You".

- Capture `no_speech_prob` and `avg_logprob` per segment into
  `RecognitionResult`.
- Add `ASR_NO_SPEECH_THRESHOLD` (start at **0.6**, between the measured 0.504 and
  0.681) and drop finals above it before they reach the pipeline.
- Add a **minimum utterance duration floor** (`ASR_MIN_FINAL_MS`, ~250 ms): below
  it, do not decode at all. Whisper hallucinates on sub-half-second audio
  regardless of model, so the cheapest fix is not to ask it.
- Pass `no_speech_prob` through the `final` protocol message and into
  `UtteranceInput`, so `src/domain/relevance.ts` can use it as one more weighted
  signal alongside the word probabilities it already reads.

One measured case deserves care: speech buried in suction at 0 dB produced
`"That's why it's all in there."` at `no_speech_prob` 0.552 — a confident
hallucination that a threshold will *not* catch. It survives only because it
contains no clinical vocabulary and the relevance stage rejects it. Keep that
defence; do not let the new gate become the only one.

### 2.3 Capture path — `public/audio/pcm-capture-worklet.js`

- Add an anti-aliasing low-pass (~7.6 kHz) before decimation. A short windowed-sinc
  or a small cascaded biquad is enough; it runs per 128-sample render quantum, so
  keep it allocation-free.
- Extend `tests/worklet.test.ts` with a tone above 8 kHz and assert it does not
  appear below Nyquist after resampling — a negative control the current tests
  lack.

### 2.4 Endpointing — `server/audio.py`, `server/config.py`

- Replace the fixed `ASR_VAD_RMS_THRESHOLD` with a **noise-floor-relative**
  threshold: track a rolling minimum and require speech to exceed it by a
  configurable margin. This fixes both the measured p10 problem and microphone
  gain variation, and it is a small change to `SpeechSegmenter.feed`.
- Keep the existing absolute threshold as a floor so a silent room cannot make
  the relative threshold collapse.
- Extend `tests/server/test_audio.py` with quiet-speech and loud-room cases.

---

## Phase 3 — Tune on real audio, then update the contracts

Only now, with Phase 1 in place:

1. Re-run `scripts/evaluate_dental.py` across `tiny.en` / `base.en` / `small.en`
   and beam 1 / 5 **on the dental fixture**, and put those numbers in
   `EVALUATION.md` beside the JFK ones.
2. Settle the biasing question with data — `initial_prompt` on/off/`hotwords` on
   real dental speech. If the prompt loses, delete it and
   `shared/dental-prompt.json` with it rather than leaving a component that is
   there because it sounded right.
3. Tune `ASR_NO_SPEECH_THRESHOLD` and the VAD margin against the measured
   distributions instead of the two-point separation available today.
4. Update the latency budget in `ARCHITECTURE.md` to the measured base.en
   numbers, and re-run `scripts/evaluate_acoustic.py --gate`, whose promotion
   rule may now behave differently under a stronger model.

---

## Verification

```bash
# Phase 1 — record, then measure the thing that was broken
PERIO_FIXTURE_CAPTURE=1 npm run dev
#   open http://127.0.0.1:5173/?record=1 and read the prompts aloud
uv run python scripts/evaluate_dental.py --json /tmp/transcripts.json
node scripts/evaluate-clinical.mjs --transcripts /tmp/transcripts.json

# Phase 2 — nothing regresses
node scripts/verify-quality.mjs
node /home/adithyan/.claude/skills/unlazy/scripts/gate-check.mjs --reverify --timeout 600 GATES.md

# Phase 3 — the numbers that decide the tuning
uv run python scripts/evaluate_dental.py --sweep-models
uv run python scripts/evaluate_acoustic.py --gate
```

Then use it: `npm run dev`, say `three four five`, `bleeding`, `four no three`,
and confirm by feel as well as by number — the complaint that started this was a
felt one.

## Notes

- `GATES.md` gets `G26` (dental fixture end-to-end) and the re-verified existing
  26. Phase 2 changes `server/recognizer.py` and the worklet, both of which sit
  behind existing gates, so `--reverify` is mandatory rather than optional —
  evidence binds the check definition, not the scripts a check calls.
- Fixture audio is voice data. `.gitignore` it, commit only `phrases.json` and
  the metrics.
- If the 4060 is enabled at any point, re-run the Phase 3 sweep with
  `ASR_DEVICE=cuda` before deciding anything; it plausibly makes `small.en` the
  default and retires this whole trade-off.
