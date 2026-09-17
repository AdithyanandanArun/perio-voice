# Perio Voice — working context

Local clinical voice intelligence layer for periodontal charting. Browser mic →
local Faster-Whisper → a deterministic clinical pipeline that decides what
belongs in the chart, what it means, and where it goes.

**The product is not the transcription.** It is the layer between recognition and
the record. The recognizer is replaceable; that layer is the value. Read
`ARCHITECTURE.md` before changing anything structural, and `next.md` for what is
planned next.

## Commands

```bash
npm run dev                      # backend (:8000) + frontend (:5173), one command
node scripts/verify-quality.mjs  # lint, types, all tests, build — both stacks
node scripts/evaluate-clinical.mjs   # chart-level metrics, 11 cohorts
uv run python scripts/evaluate_acoustic.py   # word error rate under noise
uv run python scripts/calibrate_speaker.py   # re-measure speaker thresholds

# the acceptance ledger — 26 gates, each naming the one command that decides it
node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status GATES.md
node ~/.claude/skills/unlazy/scripts/gate-check.mjs --reverify --timeout 600 GATES.md
```

## Layout

- `src/domain/**` — the clinical pipeline. **Pure and ASR-independent.** The only
  place clinical meaning is decided. `pipeline.ts` runs the stages;
  `clinicalEngine.ts` is the public façade; `index.ts` is the barrel the
  evaluation harness bundles.
- `src/domain/sessionReducer.ts` — the **single** chart transition boundary.
  Speech, simulator, buttons and approved confirmations all arrive here.
- `src/components/**` — renders state. Never parses clinical language.
- `server/**` — transport, recognition, endpointing, speaker, telemetry.
- `evaluation/**`, `scripts/evaluate-*` — the two harnesses. See `EVALUATION.md`.
- `shared/dental-prompt.json` — one recognizer prompt, read by both stacks.

## Invariants — do not "simplify" these away

1. **Stage order carries the safety argument.**
   `speaker → staleness → lexicon → lattice → relevance → context resolution →
   grammar → negation → correction → sequence guard → commit`.
   Speech that is not the clinician's, or that a location change overtook, must
   stop before it influences anything. Relevance runs on **safe vocabulary only**,
   so the risky lexicon variants (`buckle`→buccal, `black`→plaque) cannot be what
   makes casual speech look clinical.
2. **No partial writes.** A group of values is accepted or rejected whole. A
   partial write is precisely the state a sequence drifts from — one dropped value
   does not make one wrong measurement, it makes every following measurement land
   on the wrong site.
3. **Context can repair a misheard word but never manufacture a measurement.**
   A substituted reading (`to`→2) is admissible *only* inside a value window the
   context already opened. This is structural, not statistical — do not replace it
   with a confidence score.
4. **Literal out-of-range numbers stay intact.** "three thirteen five" must reach
   validation and be rejected as a unit, not be quietly repaired into something
   plausible.
5. **Uncertain means ask, not guess.** A false chart entry costs far more than an
   utterance the clinician repeats. The `uncertain` relevance band, the
   low-confidence polarity hold and the cross-station correction hold are all
   deliberate. Approving one replays the original utterance through the whole
   pipeline with an override attached, so approved values are audited like spoken
   ones.
6. **Only a location change bumps `context.version`.** Advancing through the three
   sites of a station must not, or every final would look stale.

## Things that will bite you

These each cost real debugging. They are not obvious from the code.

- **The evaluation cannot see recognition quality.** `evaluate-clinical.mjs`
  supplies transcripts and skips the recognizer; the acoustic fixture is 11
  seconds of a political speech. So WER 0.000 and "the voice recognition is
  terrible" are both true at once. Do not quote the harness as evidence about
  dental speech. Fixing this is Phase 1 of `next.md`.
- **The JFK fixture has ~22 reference words, so one word error is 0.045 WER.**
  Differences of 1–2 word errors are *not* evidence. A confident conclusion was
  drawn twice from exactly that and was wrong both times.
- **Never derive a random seed from `hash()`.** Python salts string hashing per
  process. The acoustic harness did this, silently tested different noise every
  run, and put a wrong conclusion into the docs. Seeds are fixed constants in
  `scripts/evaluate_acoustic.py`; keep them that way.
- **Use `no_speech_prob`, not `avg_logprob`,** to detect non-speech. Measured:
  real speech 0.018–0.504, silence/hiss/suction/handpiece 0.681–0.964. Room hiss
  scored *better* than real speech on `avg_logprob` (−0.180 vs −0.873).
- **Auto-advance is lazy on purpose.** A finished station is left behind only when
  the next *measurement* arrives. Making it eager sends a finding or a correction
  spoken right after the last depth to the next tooth. The clinical corpus caught
  this; it is a real defect, not a test artifact.
- **`initial_prompt` corrupts short utterances.** Measured across tiny.en and
  base.en: a 0.4 s clip gives `'My f***.'` prompted vs the correct `'my fellow'`
  unprompted. `hotwords` measured *worse* than both. Settle this on real dental
  audio before touching `shared/dental-prompt.json`.
- **Whisper hallucinates on sub-second audio regardless of model size** —
  `'Bye bye.'`, `'life.'`, `'You'`. Decode time is flat with utterance length
  (fixed 30 s encoder window), so you pay full price for the word "three".
- **Trace details must stay structural, not echo the event message.** Two
  UI tests broke on duplicate text when they did.
- **Gate evidence binds the check *definition*, not the scripts a check calls.**
  Change a script a gate runs and the evidence still looks current. `--reverify`
  after touching anything under `scripts/`, `server/` or `src/domain/`.

## Conventions

- **Gates before implementation.** `GATES.md` is the acceptance contract; every
  gate names one command whose success marker decides it. Gates must be able to
  fail — negative-control them.
- **Commit messages explain *why*, not what.** The diff shows what changed. Say
  what was wrong, what the evidence was, and what was traded. No `Co-Authored-By`
  trailers in this repo.
- **Measure before claiming.** Re-run the numbers immediately before writing them
  down, and state what a measurement does *not* establish.
- Python: ruff + mypy strict, `uv run`. TypeScript: strict, ESLint
  `--max-warnings 0`. CI runs every gate that does not need a downloaded model.

## Status

26/26 gates met and re-verified. 155 frontend tests, 65 Python tests. Clinical
eval 86/86 exact match, 0/24 false chart entries, parser p95 < 0.3 ms.
Recognition quality is the open problem — see `next.md`.

`ARCHITECTURE.md` ends with **"What is not built"**. Read it before promising
anything: recorded operatory audio, a dental speech corpus, trained speaker
embeddings, overlapping speech, a model-worker pool, persistence and metric
export do not exist.
