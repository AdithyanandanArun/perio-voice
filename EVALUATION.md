# Evaluation

Three harnesses measure different boundaries, and they are kept apart on purpose.
A word-perfect transcript can still produce a wrong chart, and a transcript full
of errors can still produce a right one once the clinical layer has resolved it.
Reporting them together hides which half of the system moved.

| Harness | Question | Command |
| --- | --- | --- |
| Acoustic | Did the recognizer hear the words? | `uv run python scripts/evaluate_acoustic.py` |
| Dental recording | Did the room/device path hear each dental phrase? | `uv run python scripts/evaluate_dental.py` |
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

## Recognizer tier

`scripts/evaluate_recognizers.py` scores engines on
`evaluation/fixtures/synthetic-dental/` — thirty charting utterances at a mean of
0.91 s, which is the length the product actually hears. It exists because the
long-form fixture reported word error rate 0.000 while real charting worked about
a quarter of the time.

| engine | word error rate | exact match | ms/utterance |
| --- | ---: | ---: | ---: |
| Whisper `tiny.en`, beam 5 | 0.820–0.910 | 33–40% | 280–315 |
| grammar-constrained | 0.132 | 80% | 167–171 |

The ranges are four immediate runs on the reference CPU. Whisper's temperature
fallback varies on these very short clips; the grammar result was stable. The
grammar score is the post-safety value: an earlier context-narrowed grammar
reached 93%, but could force one legitimate clinical word onto another. The
current recognizer uses the full clinical grammar and may abstain instead of
substituting. `--verbose` prints every miss, and the gate now treats one
additional failed clip or WER above 0.14 as a regression.

### Model size is not the variable

Measured on short utterances before the grammar recognizer existed:

| engine | exact match |
| --- | ---: |
| Whisper `tiny.en` | 30% |
| Whisper `base.en` | 23% |
| Whisper `distil-small.en` | 23% |
| Whisper `small.en` | 27% |

`base.en` scores below `tiny.en`. Six calling conventions were also tried —
padding to one and three seconds, `vad_filter`, temperature fallback, a
no-speech threshold — and none exceeded 33%. Padding short audio to three seconds
was actively harmful, producing word error rates above 29 from hallucination over
the silence. Whisper is a thirty-second sequence model being asked to resolve a
half-second command; that is a shape mismatch, not a capacity limit.

### Two words had to be removed from the grammar

The routing gate caught both, and both would have been chart errors:

- `free` is a near-homophone of `three` and won inside a grammar containing
  both, so the utterance "three" was recognized as "free".
- `pus` is short and collides with ordinary speech: "can you pass me that" was
  recognized as "pus meant that", which would have written a suppuration finding
  out of a request to an assistant.

Both have unambiguous synonyms already in the grammar. The gate now fails on any
chartable content emitted from conversational audio, not just on digits.

### A larger acoustic model is not available to this approach

`vosk-model-en-us-0.22` (2.7 GB unpacked) was measured and rejected. It refuses
runtime grammars — `Runtime graphs are not supported by this model` — so it can
only run unconstrained, and unconstrained is exactly the mode that performs
badly here:

| model | grammar | word error rate | exact match | ms |
| --- | --- | ---: | ---: | ---: |
| `vosk-model-en-us-0.22-lgraph` (128 MB) | yes | 0.132 | 80% | 167–171 |
| `vosk-model-en-us-0.22` (2.7 GB) | no | 0.211 | 73% | 275 |

The grammar is doing the work, not the acoustic model's size. Among English Vosk
models only the `-lgraph` variants accept a runtime grammar, so this is the
ceiling for the constrained approach locally rather than a tuning choice.

### What this does and does not establish

The audio is **synthesized, one voice, no room**. Absolute accuracy here is
optimistic for every engine. Use it to compare engines against each other, which
is what the gate does; do not quote 80% as a real-clinic recognition rate. A recorded fixture
from real clinicians is the measurement that settles accuracy, and
`evaluation/fixtures/dental/` exists to hold one.

## Loudspeaker TTS replay tier

The opt-in fixture recorder can now fill the dental recording corpus without a
person reading every prompt. The pinned local Piper TTS voice is played through the
laptop speakers while the microphone is recorded through the production
AudioWorklet and 16 kHz PCM path. The quiet pass plays speech alone; the noise
pass adds a deterministic synthetic suction/handpiece bed. The run rejects an
inaudible first or later clip at the browser boundary instead of creating a
plausible-looking corpus of silence.

Automated audio is stored separately from human audio:

```text
evaluation/fixtures/dental/audio/tts-replay/quiet/<utterance-id>.wav
evaluation/fixtures/dental/audio/tts-replay/noise/<utterance-id>.wav
```

That isolation is enforced by the upload API rather than naming convention, so
an automated pass cannot overwrite a clinician recording. Both trees remain
git-ignored. To capture and evaluate the automated corpus:

```bash
PERIO_FIXTURE_CAPTURE=1 npm run dev
# Open http://127.0.0.1:5173/?record=1 and start the local-TTS run.

uv run python scripts/evaluate_dental.py \
  --audio-root evaluation/fixtures/dental/audio/tts-replay \
  --json /tmp/tts-replay-transcripts.json
node scripts/evaluate-clinical.mjs --transcripts /tmp/tts-replay-transcripts.json
```

Echo cancellation is disabled only during loudspeaker replay; otherwise it would
remove the signal being measured. Noise suppression and automatic gain control
remain off, matching live capture. The normal recognition profile retains echo
cancellation.

### What this does and does not establish

Unlike direct WAV decoding, loudspeaker replay exercises the physical output,
room, microphone, browser permission, anti-alias filter and resampler before
recognition. It is a useful repeatable integration baseline and can expose a
muted speaker, wrong microphone, echo-cancellation mistake or capture-path
regression.

It remains one synthesized voice with synthesized noise. It does not establish
clinical performance across human accents, pacing, low-volume speech, masks,
different microphones, or actual operatory acoustics. A consented real-clinician
quiet/noise corpus remains the final validation dataset; TTS replay reduces the
manual work needed to diagnose the system but does not turn synthetic evidence
into clinical evidence.

## Choosing the recognizer on replay audio

Every earlier recognizer decision was made on synthesized WAV files decoded
directly, and each overestimated real use: the grammar recognizer's 80% exact on
synthetic phrases became 54.8% chart exact once the same kind of speech crossed a
loudspeaker, a room and a microphone. `scripts/bakeoff.py` therefore decides on
the replay recordings and scores each candidate by the chart it produces through
`evaluate-clinical.mjs --transcripts`, not by word error rate, which punishes
formatting ("three" against "3") the chart may not care about.

```bash
uv run --extra gpu python scripts/bakeoff.py --engines shipped,grammar,tiny.en
uv run --extra gpu python scripts/bakeoff.py --rescore      # re-score saved transcripts only
uv run --extra gpu python scripts/bakeoff.py --gate         # G43
uv run --extra gpu python scripts/verify_live_recognizer.py --gate   # G44
uv run python scripts/verify_latency_quality.py --unit               # deterministic controls
node scripts/verify-competitive-latency.mjs                          # docs/mapping contract
uv run --extra gpu python scripts/verify_latency_quality.py --gate   # live gate + independent parse
uv run --extra gpu python scripts/verify_noise_rejection.py          # G46
```

`shipped` reads the prompt from `shared/dental-prompt.json` through the same bias
path the service uses, so the number it prints describes what runs. Measured
immediately before this was written, on all 138 recordings:

| recognizer | chart exact | false entries | decode p50 / p95 |
| --- | ---: | ---: | ---: |
| `large-v3` + example prompt + speech checks, CUDA `int8_float16` | 93.3% (97/104) | 1/28 | 335 / 373 ms |
| the same without the speech checks | 94.2% (98/104) | 1/28 | 331 / 364 ms |
| grammar-constrained, CPU | 54.8% (57/104) | 2/28 | 415 / 617 ms |
| `tiny.en`, CPU | 53.8% (56/104) | 3/28 | 174 / 209 ms |

From earlier runs on the same recordings: unprompted `large-v3`,
`large-v3-turbo` and `distil-large-v3` all sat at 66–67%. On `large-v3-turbo`, a
descriptive prompt reached 73%, `hotwords` 79%, the first example prompt 79% and
the refined one 84.6% at 235 ms median; the refined prompt on `large-v3` reached
92–94%. Model size is not the variable here either; the prompt is.

The bake-off decodes each recording whole. `scripts/verify_live_recognizer.py`
starts the real service with no `ASR_*` overrides and streams every recording
over `/ws/asr`. Browser capture uses 40 ms live frames; this evaluator keeps
100 ms fixture frames for compatibility while still exercising the real energy
endpointer, partial decodes and decode queue. It reports how many recordings
the endpointer split into several finals and measures the complete client-side
critical path: the additive `endpoint` event, captured sample timing for the
last voiced sample and endpoint, and endpoint→final event-arrival latency. A
recording that ends in several finals is replayed as several utterances,
because that is what the pipeline receives.

The fresh pre-fix reference is 94.2% (98/104) chart exact, 1/29 false entries,
one split recording (a sound after speech became its own, non-charting final),
endpoint→final 298 ms median and 338 ms at p95, streamed at twice real time.
The earlier published run was 344 ms median and 420 ms p95; both numbers are
kept as context rather than blended into one result. The evaluator emits a
`liveTiming` object with raw endpoint→final, semantic hangover and
last-voiced-sample→final arrays so a second process can recompute the gate.

This is explicit endpoint/sample timing evidence, not an inference from a
rounded summary line.

### Live critical-path contract

`endpoint`/`speech_end` is an additive boundary event and must precede the
matching non-empty `final`. Its sample evidence includes `sampleRate`,
`startSample`, `endSample` and `lastVoiceSample` (or equivalent explicit
offsets), plus `endpointReason` — one of `semantic` (a short 120–200 ms
hangover after a grammar semantic-complete hint), `silence` (the ordinary
trailing-silence window), `max_length` or `stop`. The `endpoint` and `final`
of one utterance agree on the reason. Semantic hangover is computed from
`endSample - lastVoiceSample`; endpoint→final is measured from client arrival
of the boundary to client arrival of the final. A server that only sends the
legacy wall-clock `endedAtMs` remains useful for ordinary reporting, but the
tightened gate fails closed because that fallback cannot prove the complete
critical path — and a text final that omits `endpointReason` or
`lastVoiceSample` also fails the tightened gate closed.

Two gates run over the same live report and decide two different claims, not
one gate under two names:

- `verify_live_recognizer.py --gate` decides only project gate G44
  (`GATES.md`): ≥90% chart exact, ≤2 false entries, ≤3 split recordings,
  endpoint→final p95 ≤700 ms, on `large-v3`/CUDA. It always writes the full
  `liveTiming` evidence (`endpointReason`, `lastVoiceSample`, and the
  coverage counts below) regardless of which gate is run.
- `verify_latency_quality.py --gate` re-runs that evaluator and applies the
  tightened, narrower contract below. A report can satisfy G44 while failing
  this gate.

The tightened contract's endpoint→final control covers every text final
regardless of `endpointReason`; the semantic hangover and composed
last-voiced-sample→final controls apply **only** to `semantic`-reason
finals, because conversational speech the clinical grammar cannot
semantically complete correctly is expected to ride out the ordinary
silence window instead — that is a correct outcome, not a latency defect,
and scoring it against the semantic budgets would fail a correct product.
The silence-endpoint composed latency is reported (p50/p95) but not gated.

The terminal replay bar is intentionally independent of latency:

| Control | Tightened gate |
| --- | ---: |
| Chart exact match | ≥98/104 cases |
| False chart entries | ≤2 |
| Split recordings | ≤3 |
| Endpoint→final (all text finals) | p95 ≤450 ms |
| Semantic last-voiced-sample→endpoint hangover (`semantic`-reason finals only) | max ≤200 ms |
| Last-voiced-sample→final (`semantic`-reason finals only) | p95 ≤650 ms (450 + 200 composition) |
| Semantic-reason coverage of chartable text finals | ≥80% |
| Missing `endpointReason` or `lastVoiceSample` on a text final | fails closed |
| Runtime | `large-v3` on CUDA |

The 80% coverage control exists so that a semantic fast path which never
fires (an empty set of `semantic`-reason finals) fails instead of silently
passing every other control by having nothing to measure.

The 450 ms endpoint budget is a small hardware allowance around the measured
338 ms p95 reference and the earlier 420 ms p95 report; it is not a clinical
service-level claim. `verify_latency_quality.py --unit` exercises each passing
boundary and failure control without a model, including 201 ms semantic
hangover, a composed semantic p95 over 650 ms, 79% semantic coverage, a
missing `endpointReason`, and the positive control that a long
silence-endpoint hangover does not fail the semantic control. `--gate` runs
the live evaluator, then parses its raw JSON arrays and independently
recomputes chart, false, split, evidence-coverage and percentile controls
before printing a pass marker.
The replay is one synthetic Piper voice through a local capture path, so these
numbers do not establish clinician performance, CareStack latency, or a medical
claim. This is not a clinical claim.
The source-grounded workflow comparison is maintained separately in
[docs/CARESTACK_LATENCY_GAP_ANALYSIS.md](./docs/CARESTACK_LATENCY_GAP_ANALYSIS.md).

### Noise must not become chart text

The whole-clip bake-off contains no noise-only segments, so it could not see the
largest risk of prompting: given noise, the prompted model recites its prompt.
Endpointed operatory bursts came back as "b o p d three four five.", "three four
five." and, with word timings on, "next tooth.", while the prompt held Whisper's
no-speech estimate at 0.09–0.29 on noise against at most 0.122 on speech — so no
single threshold on it separates them. Silero VAD alone does not either: loud
scaler whine reaches 0.88.

The two fail on different inputs. Every burst that passed Silero scored at least
0.174 on the prompted no-speech estimate. So the service requires both, plus a
saturation check for broken captures (three uploaded "human" clips turned out to
be constant full-scale noise that decoded as "b o p d three four five." past both
other checks).

`scripts/verify_noise_rejection.py` streams 249 bursts — six operatory sources,
four durations, five levels, clicks and saturated captures — through a real
session on the shipped recognizer. The thresholds were calibrated on
realizations 1–8; the gate uses 9 and 10, because a first version checked only
calibration noise, passed, and then leaked on the next realizations. With every
check on, none produces text; without the Silero check, 24 do and 18 look
clinical. The noise is synthesized: real suction, handpieces and scalers are not
in this set.

### What this does and does not establish

It establishes that `large-v3` with the example prompt is the best of the
measured candidates on this capture path, by a margin (39 points) far outside the
one-or-two-scenario noise of a 104-scenario set, and that the live service
reproduces the whole-clip result.

It does not establish clinician performance. The recordings are one synthetic
voice; the noise that the speech checks were tuned against is synthesized; the prompt was tuned on the same recordings it is scored on, so 94.2% is
an optimistic in-sample figure; and the six scenarios it still fails, including
the one false entry, are listed in `evaluation/results/bakeoff/shipped.json`
(ignored, regenerated by the command above). A consented human corpus remains
the validation set.

## Speaker attribution does not separate speakers

Stated plainly because the previous version of this document implied otherwise.

The original calibration compared 5.5-second segments against 5.5-second
segments from one recording and reported a comfortable +0.0507 margin. That is
not the comparison the product makes. It enrolls on several seconds of speech and
then verifies half-second utterances, and measured at those durations:

| verified window | enrolled speaker, worst | other voice, best | margin |
| --- | ---: | ---: | ---: |
| 0.5 s | 0.7662 | 0.9627 | **−0.1965** |
| 1.0 s | 0.9226 | 0.9643 | −0.0417 |
| 2.0 s | 0.9582 | 0.9529 | +0.0053 |
| 4.0 s | 0.9704 | 0.8540 | +0.1164 |

Below two seconds the distributions **invert**: a different voice scores higher
than the enrolled one. Verifying a rolling four-second window instead of each
utterance recovers some of this, but on clean single-speaker audio it still
leaves a margin of +0.0007, which is not separation.

Two real defects were fixed and are gated — enrollment now completes from one
ordinary take (4,040 ms of usable audio from six seconds, against 1,870 ms
before, which is why it used to require shouting), and half-second utterances
now produce a decision instead of a permanent unknown. But the discrimination
itself is not there, so `G33` is abandoned rather than tuned until it passes, and
the feature stays off by default.

A trained speaker-embedding model behind the same interface is the fix. A
cepstral profile was always going to be weak; the mistake was calibrating it on
the wrong pairing and believing the number.

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

### Automatic-chart transactions

`processAutoChart` has a separate deterministic test tier for multi-station
dictation. A semicolon- or newline-delimited batch is accepted only when every
directive names its tooth and surface, has no unparsed or acoustically ambiguous
terms, produces a journalled change, and passes the existing relevance, range,
sequence and stale-context guards. Tests use valid two-station notes alongside
later-clause out-of-range values, conversational language, missing locations and
stale observations; every rejected control must leave chart state, journal and
clinical context byte-for-byte equivalent to the state before the note.

The p95 planning budget is below 5 ms in the deterministic browser-domain test.
It deliberately excludes acoustic decode time and is not a clinical accuracy
claim: real clinician and operatory recordings are still required before any
clinical-performance claim.

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
node scripts/verify-acoustic-replay.mjs      # Piper stimuli, browser replay, isolated upload
node scripts/evaluate-clinical.mjs --gate    # clinical metrics
uv run python scripts/evaluate_acoustic.py --gate   # word error rate under noise
uv run python scripts/verify_model_runtime.py       # the real model, no mocks
uv run --extra gpu python scripts/bakeoff.py --gate            # recognizer choice, replay audio
uv run --extra gpu python scripts/verify_live_recognizer.py --gate   # the same, through /ws/asr
uv run python scripts/verify_latency_quality.py --unit               # deterministic latency controls
node scripts/verify-competitive-latency.mjs                          # source/mapping contract
uv run --extra gpu python scripts/verify_latency_quality.py --gate   # live latency + quality gate
uv run --extra gpu python scripts/verify_noise_rejection.py          # noise never becomes text
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
