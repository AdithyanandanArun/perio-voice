# Evaluation

Two harnesses measure two different things, and they are kept apart on purpose.
A word-perfect transcript can still produce a wrong chart, and a transcript full
of errors can still produce a right one once the clinical layer has resolved it.
Reporting them together hides which half of the system moved.

| Harness | Question | Command |
| --- | --- | --- |
| Acoustic | Did the recognizer hear the words? | `uv run python scripts/evaluate_acoustic.py` |
| Clinical | Did the chart end up correct? | `node scripts/evaluate-clinical.mjs` |

Both take `--gate` to apply their acceptance thresholds and print a pass marker;
that is how `GATES.md` consumes them. `--verbose` and `--json <path>` give the
full detail.

## Acoustic tier

`scripts/evaluate_acoustic.py` mixes the checked-in speech fixture with six
deterministic operatory noise sources — suction, handpiece, scaler, chair, HVAC
and babble — at fixed speech-to-noise ratios, runs the real local model over
every mixture, and reports word error rate per preprocessing profile.

The mixer returns the anti-clipping gain it applied, because that gain is applied
to speech and noise together; without it, recovering the achieved ratio from a
mixture would count the attenuated speech as extra noise. Every generator is
deterministic given its seed, so two profiles are always compared on identical
audio.

### Current result (tiny.en, CPU INT8, 15/5/0 dB bands, two noise realizations each)

| profile | clean WER | mean noisy WER | worst band WER |
| --- | ---: | ---: | ---: |
| none | 0.000 | 0.146 | 0.324 |
| highpass | 0.091 | 0.140 | 0.324 |
| spectral | 0.091 | 0.146 | 0.278 |

The honest reading is that **no preprocessing profile is measurably better here**.
The three sit within 0.006 mean word error of each other, which is far below this
fixture's resolution: its reference transcript is 22 words, so a single word
error is 0.045 on one mixture. `none` stays the default because it is the only
one with no clean regression.

That regression is worth naming precisely, because it is not a metric artifact:
both filtered profiles emit a hallucinated trailing `Thank you.` on clean speech,
a well-known Whisper failure mode that the filtered near-silence tail triggers.
In charting, an inserted phrase is a false-entry risk.

An earlier version of this table reported high-pass nearly halving noisy error.
That was wrong, and the way it was wrong is the reason this section exists. The
harness seeded its noise generators from `hash(source)`, and Python salts string
hashing per process, so every run tested different noise and the table moved
between runs. Seeds are now fixed constants and each condition is measured at two
realizations; two consecutive runs produce byte-identical tables. The apparent
advantage was one lucky draw.

The gate encodes the promotion policy rather than leaving it to memory. It fails
if:

- clean word error exceeds 0.15, meaning the recognizer is not healthy enough for
  any noise result to mean anything;
- the worst SNR band fails to degrade recognition at all, which would mean the
  harness is not exercising the mixture it reports — a negative control on the
  harness itself;
- another profile beats the configured one by more than 0.03 mean noisy WER
  *without* costing more than 0.03 on clean speech, in which case it should be
  promoted deliberately.

The 0.03 margin is set above the fixture's measurement resolution on purpose. A
tighter margin would make the gate flip on noise rather than on evidence.

### What this does and does not establish

The noise is synthesized. It supports relative comparison between profiles and
SNR bands on identical audio. It is not a claim about any particular clinic, and
a real promotion decision needs recordings from one. The speech is one public
fixture of a single speaker, so this tier says nothing about accent or dental
vocabulary recognition.

## Clinical tier

`scripts/evaluate-clinical.mjs` replays `evaluation/corpus/clinical.json` through
the real pipeline. The harness bundles the same TypeScript the browser runs, so
it cannot drift into testing a reimplementation.

Each case is a short charting episode: an optional starting context, a list of
utterances as a recognizer would hand them over — including its mistakes — and
the chart state that must exist afterwards. Utterances marked `chartable: false`
must never write anything, and the false chart entry rate is measured over
exactly those.

### Cohorts

| Cohort | Cases | What it exercises |
| --- | ---: | --- |
| clean | 9 | grouped and separate values, findings, spoken context |
| rapid | 5 | continuous charting, run-on sequences, findings between stations |
| conversational | 12 | patient-directed speech, requests, small talk, logistics |
| corrections | 10 | immediate, phrased, mid-station, sequence replacement, undo/redo |
| negation | 9 | cues, conjunctions, clause breaks, uncertain polarity |
| ambiguity | 6 | homophones, accented digits, out-of-range literals |
| terminology | 9 | abbreviations, multi-word terms, graded findings, named sites |
| accent | 6 | recognizer spellings of clinical vocabulary |
| multispeaker | 6 | attribution, override, unknown voices |
| context | 8 | skip, next, back, resume, stale context, quadrants |
| sequence | 6 | inserted, dropped and duplicated values |

### Metrics and thresholds

| Metric | Threshold | Current |
| --- | --- | ---: |
| Clinical exact match | ≥ 0.95 | 1.0000 (86/86) |
| False chart entry rate | ≤ 0.02 | 0.0000 (0/24) |
| Site alignment errors | 0 | 0 |
| Correction success | 1.0 | 1.0000 |
| Context success | 1.0 | 1.0000 |
| Pipeline p95 latency | < 10 ms | 0.27 ms |

Site alignment error is counted separately from value error on purpose. One
dropped value in a group of three does not produce one wrong measurement; it
produces three measurements at the wrong sites. A metric that cannot tell those
apart cannot see the failure this system exists to prevent.

### What the corpus found

The first full run failed one case, and it was a real defect rather than a wrong
expectation: with continuous charting enabled, a completed station advanced
eagerly, so `bleeding` spoken immediately after the last depth landed on the next
tooth. Advancing is now lazy — a finished station is left behind only when the
next measurement arrives — which also keeps a correction to the last value
working. That is the kind of error a transcript-level metric cannot see at all.

### What this does and does not establish

The corpus is written from the failure modes in
[Full_Problem_Statement.md](./Full_Problem_Statement.md), and its transcripts
include the substitutions real recognizers make. It measures the layer this
project contributes.

It does not measure recognition itself. Transcripts are supplied rather than
recognized, so cohorts named `accent` and `multispeaker` exercise how the
pipeline handles accented *recognizer output* and attributed speech, not how well
the acoustic model handles accented audio or how well attribution works on real
voices. Those need consented recordings from multiple speakers, which this
prototype does not have.

## Speaker calibration

`uv run python scripts/calibrate_speaker.py` re-measures the separation the
speaker thresholds depend on and prints where they sit:

```text
enrolled speaker, worst held-out score : 0.9895
other voices, best score               : 0.9388
configured accept / reject             : 0.975 / 0.955
margin                                 : +0.0507
```

The negative case is the fixture resampled so pitch and formants move together —
a different voice that kept the original speaking style, phrasing and recording
channel, which makes it a deliberately hard negative. `tests/server/test_speaker.py`
asserts the relationship between the measured scores and the configured
thresholds rather than asserting the numbers, so the test fails if the separation
disappears.

## Running everything

```bash
node scripts/verify-quality.mjs              # lint, types, tests, build, both stacks
node scripts/evaluate-clinical.mjs --gate    # clinical metrics
uv run python scripts/evaluate_acoustic.py --gate   # word error rate under noise
uv run python scripts/verify_model_runtime.py       # the real model, no mocks
```

`GATES.md` is the full acceptance ledger; every gate names the command that
decides it.

## Reporting a change

Any change that can alter a chart event ships with:

1. before/after numbers from both harnesses;
2. latency percentiles;
3. the specific cases that changed, with their transcripts;
4. the configuration needed to roll back.

Version the corpus and the lexicon together with the change, since a metric
movement means nothing without knowing which of the two moved.
