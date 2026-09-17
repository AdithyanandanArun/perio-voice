# Perio Voice architecture

## Purpose and constraints

Perio Voice is a local-first clinical voice intelligence layer. Microphone audio
becomes partial and final English transcripts on the machine it was captured on,
and those transcripts pass through a deterministic clinical pipeline that decides
what belongs in a periodontal chart, what it means, and where it goes.

The product is not the recognizer. The recognizer is replaceable; the value is
the layer between it and the record, which is why speech recognition and clinical
interpretation are separated by a hard boundary and evaluated with different
metrics.

The current release is a prototype, not a medical device. Its safety posture is
conservative throughout: partial hypotheses never mutate the chart, invalid or
overflowing sequences are rejected as a unit, anything the pipeline is unsure of
is held for a human decision rather than guessed, and the deterministic simulator
remains available when the voice service is not.

## Runtime topology

```text
Browser (React)
  getUserMedia
    → AudioWorklet (mono, resample, 16 kHz PCM16, 100 ms frames)
    → binary WebSocket /ws/asr
        → FastAPI connection/session boundary
        → energy VAD + pre-roll + cadence-adaptive endpointing
        → bounded latest-partial-wins decode queue
        → preprocessing profile (none | highpass | spectral)
        → Faster-Whisper tiny.en (CPU INT8), biased with the dental prompt
        → speaker verification against the enrolled clinician
    ← speech_start / partial / final (+ words, speaker, cadence) / error
  final transcript only
    → clinical intelligence pipeline (below)
    → immutable session reducer
    → live chart + append-only journal + audit trail + latency samples

Transcript simulator ──────────────────────────────────────┘

GET /api/health   ← model lifecycle, runtime contract, enrolment state
GET /api/metrics  ← bounded counters and duration histograms
POST /api/speaker/enroll, /api/speaker/reset ← local, revocable voice profile
```

Component ownership:

- `public/audio/pcm-capture-worklet.js` — capture-thread resampling, PCM16
  conversion, 100 ms batching, transferable delivery, input level.
- `src/speech/useLocalAsr.ts` — microphone permission, socket lifecycle,
  reconnects, model states, enrolment capture, and complete resource cleanup. It
  reads the clinical context version at speech start, not at commit.
- `server/audio.py` — PCM validation, energy endpointing, pre-roll, partial
  cadence, maximum utterance duration.
- `server/cadence.py` — adapts the endpoint threshold to the speaker's pacing.
- `server/denoise.py` — named preprocessing profiles.
- `server/speaker.py` — enrolment and verification of the clinician's voice.
- `server/session.py` — per-stream backpressure and serialized recognition.
  Pending partials may be superseded; finals are never intentionally dropped.
- `server/recognizer.py` — the inference adapter. One lazily loaded model, CPU
  decode kept off the event loop, biased with the shared dental prompt.
- `server/telemetry.py` — bounded, identifier-free counters and histograms.
- `src/domain/**` — the clinical pipeline. Pure, ASR-independent, and the only
  place clinical meaning is decided.
- `src/domain/sessionReducer.ts` — the single chart transition boundary.

## The clinical intelligence pipeline

One recognition result enters and a chart transition, a held confirmation or a
recorded refusal comes out. Each stage is a separate, independently testable
decision, and each appends to a trace the interface can display.

```text
speaker → staleness → lexicon → lattice → relevance → context resolution
        → grammar → negation → correction → sequence guard → commit
```

The order carries the safety argument. Speech that is not the clinician's, or
that was overtaken by a change of location, is stopped before it can influence
anything downstream. Relevance runs on safe vocabulary only, so the risky lexicon
variants can never be what makes casual speech look clinical.

### 1. Speaker attribution — `server/speaker.py`, `src/domain/pipeline.ts`

The enrolled clinician is described by two views of their voice: the long-term
average log-mel spectrum, and the mean and spread of the cepstral coefficients.
An utterance is accepted only when both agree, which is what creates the margin.
Measured on the checked-in fixture, held-out speech from the enrolled speaker
scores 0.9895 while a deliberately hard negative — the same recording resampled
so pitch and formants move together, keeping the speaking style — peaks at
0.9388. The thresholds sit inside that gap, and `scripts/calibrate_speaker.py`
re-measures it rather than asserting it.

Anything between the thresholds reports `unknown` and is held for a human
decision. Enrolment data stays in process memory, is never written to disk, and
is revoked by a single request. Attribution is always visible and always
overridable, because hidden attribution is worse than none: a clinician cannot
correct a decision they cannot see.

**This does not currently work, and it is off by default.** The calibration above
compared equal-length segments, which is not the comparison the product makes.
Measured at real durations — enrollment on several seconds, verification on a
half-second utterance — the distributions invert below two seconds: the enrolled
speaker scored 0.766 where another voice scored 0.963. A rolling four-second
window recovers some separation but still leaves a margin of +0.0007 on clean
audio. Gate `G33` is abandoned rather than tuned. Enrollment and short-utterance
handling were genuinely repaired and are gated; the discrimination is not there.
See [EVALUATION.md](./EVALUATION.md#speaker-attribution-does-not-separate-speakers).

Known limits: a spectral profile is not a biometric identity claim. It separates
clearly different voices and abstains otherwise, it degrades with heavy noise and
very short utterances, and it does not handle overlapping speech. Pitch was
evaluated as a third view and deliberately left out — median F0 varies by more
than fifteen percent between five-second segments of one speaker, which is the
same order as the difference it would need to detect. A production deployment
wanting stronger attribution should add a trained speaker-embedding model behind
the same interface and re-run the calibration script.

### 2. Staleness — `src/domain/workflow.ts`

Every location change bumps `context.version`; advancing through the three sites
of one station does not, because that is charting working as intended. A final
carries the version observed when the clinician started speaking, so a result
overtaken by a jump is refused instead of landing in a location they had already
left.

### 3. Dental lexicon — `src/domain/lexicon.ts`

A versioned map from what recognizers and speakers actually produce to canonical
clinical tokens: abbreviations (`b o p`, `p d`, `m b`), multi-word terminology,
and the substitutions a general model makes for rare vocabulary.

Variants are split by risk. A `safe` variant is already clinical or is not
plausible conversational English, so it always applies. A `contextual` variant is
an ordinary English word that is a frequent substitution — *buckle*, *vacation*,
*black* — and applies only after relevance has judged the utterance clinical.
Without that split, the vocabulary that repairs clinical speech would also be
what makes casual speech look clinical.

The same vocabulary supplies the recognizer's biasing prompt through
`shared/dental-prompt.json`, so the browser and the Python service bias
identically and a vocabulary change cannot land on one side only.

### 3b. Recognizer routing — `server/routed_recognizer.py`, `server/vocabulary.py`

Two engines with opposite strengths. The grammar recognizer is given the clinical
vocabulary, so inside a grammar the decoder chooses between words a clinician
could actually be saying; Whisper has an open vocabulary, which free-form
dictation needs. Routing is by declared clinical expectation rather than by
confidence, so the decision is inspectable and a rerun routes identically.

Measured on spoken dental phrases: grammar 0.060 word error and 93% exact at
163 ms, against Whisper `tiny.en` at 0.787 and 40% at 272 ms. Whisper size does
not close that gap — `base.en` scores below `tiny.en` — because a thirty-second
sequence model resolving a half-second command is a shape mismatch rather than a
capacity limit.

Words a grammar lists but the lexicon lacks are dropped silently, and Vosk
reports that only on C-level stderr. `scripts/verify_grammar_lexicon.py` gates
coverage and `KNOWN_LEXICON_GAPS` records the genuine absences, so a clinical
term can never be unrecognizable without someone deciding it may be.

Grammar membership is a safety property, not only an accuracy one, so words are
excluded when they collide with ordinary speech: `free` beat `three`, and `pus`
turned "can you pass me that" into a suppuration finding.

### 4. Candidate lattice — `src/domain/lattice.ts`

Short clinical words carry almost no linguistic context, so a recognizer that
heard the sound correctly still picks the wrong word. Each token becomes a small
curated candidate set with a prior: the literal reading, any canonical term, and
attested substitutions (`to`→2, `for`→4, `ate`→8, `forty`→14). The sets are
hand-curated rather than a phonetic expansion, because an unbounded expansion
would let context invent values that were never spoken.

### 5. Relevance — `src/domain/relevance.ts`

Weighted, explainable evidence for and against chartability: measurement-shaped
phrasing, clinical vocabulary and a value count matching the open sites for;
patient-directed speech, requests, interrogatives, hedging, politeness, practice
logistics, out-of-vocabulary words and low recognizer confidence against.

Three outcomes: `chartable`, `non_chartable`, and `uncertain`, which is displayed
and held rather than committed. The asymmetry is deliberate — a false chart entry
costs far more than an utterance the clinician repeats. `relevanceMode: 'shadow'`
scores without blocking, which is how a classifier change is evaluated before it
can affect a chart.

### 6. Context resolution — `src/domain/contextResolver.ts`

Decides which candidate reading the active clinical state permits. The safety
property is structural rather than statistical: a substituted reading is
admissible only inside a value window the context already opened, so context can
repair a misheard word but cannot manufacture a measurement. A number directly
after a binding term sees only that binding's window, which is why "mobility ten"
stays words while "tin" alone reads as a depth. A literal out-of-range number is
left intact so range validation still rejects it as a unit.

Budget: under 20 ms, measured in `tests/disambiguation.test.ts`.

### 7. Grammar — `src/domain/grammar.ts`

Typed intents: workflow commands, anatomical context, measurements, sequence
replacement, corrections and findings. One utterance can carry several, emitted
in the order they must be applied. The grammar declines anything it does not
recognize, so an unparsed sentence becomes visible rather than a guess.

### 8. Negation — `src/domain/negation.ts`

A cue opens a negative scope that travels forward over the findings it governs,
rides a conjunction, reaches across a modifier the recognizer kept, and closes at
a measurement or a clause break. Every assertion records its cue, span and
confidence. Constructions where English itself is ambiguous — `and` after a cue,
a trailing cue, a doubled cue — resolve to a definite polarity at reduced
confidence and are confirmed rather than written, because polarity reverses
clinical meaning.

### 9. Corrections and the journal — `src/domain/journal.ts`, `correction.ts`

Every write is recorded with its previous value in an append-only journal.
Corrections resolve against that journal rather than the transcript: they name an
existing write, replace it in place, and supersede the old entry without deleting
it. Undo and redo append compensating entries. A correction reaching past the
active station is real but rewrites a location the clinician has left, so it is
confirmed rather than applied.

### 10. Sequence guard — `src/domain/sequenceGuard.ts`

Grouped measurements are positional, so one inserted or dropped value does not
produce one wrong measurement — it produces every following measurement at the
wrong site. The guard validates a candidate group against the sites that are
actually open and accepts or rejects it whole. There is no partial write, because
a partial write is the state a sequence drifts from. A property test over random
spoken groups asserts that the charted station always equals the concatenation of
the accepted groups.

### 11. Workflow position — `src/domain/workflow.ts`

The mouth is 64 ordered stations on the conventional serpentine path. The
clinician advances, steps back, marks a tooth absent, jumps away and resumes
exactly where charting stopped. Continuous charting advances lazily: a finished
station is left behind only when the next measurement arrives, so a finding or a
correction spoken immediately after the last depth still belongs to the tooth
just charted.

### 12. Cadence-adaptive endpointing — `server/cadence.py`

Endpointing follows the speaker rather than the reverse. The controller reads the
pauses the recognizer already timestamps, tracks their high percentile rather
than the mean, and moves the threshold inside a safe band. A one-word utterance
carries no pause evidence, so it leaves the threshold alone instead of collapsing
it toward the floor. Clipping a value mid-word costs far more than waiting another
hundred milliseconds.

### 13. Noise robustness — `server/denoise.py`, `evaluation/noise.py`

Preprocessing is a named profile, not a fixed step, and the default is `none`.
`scripts/evaluate_acoustic.py` mixes the speech fixture with six synthesized
operatory sources at fixed speech-to-noise ratios and measures word error rate
per profile. A profile is promoted only on that evidence, and the gate refuses to
trade the common case for the rare one. See [EVALUATION.md](./EVALUATION.md) for
the current numbers and what they do and do not establish.

## WebSocket protocol v1

The server begins every connection with `hello`, including protocol version and
required audio format, followed by `model_status` or `model_ready`. The browser
sends UTF-8 JSON control messages and binary audio frames.

Client controls:

```json
{"type":"start"}
{"type":"stop"}
{"type":"ping"}
{"type":"retry_model"}
```

Binary payloads are little-endian signed PCM16, mono, 16,000 Hz. Frames are
normally 3,200 bytes (100 ms), but the server validates framing rather than
assuming one packet size.

Server events:

- `hello` — protocol and audio contract.
- `model_status` / `model_ready` — lifecycle, model name, device, compute type,
  sample rate, safe error text.
- `listening` — the session can accept binary frames.
- `speech_start` — utterance id and server monotonic start time.
- `partial` — replaceable hypothesis, audio/decode duration, dropped-partial
  count.
- `final` — commit-eligible transcript, word timestamps, audio/decode duration,
  utterance id, speaker verdict (when a clinician is enrolled) and the cadence
  state that resulted.
- `stopped` — stream drain complete.
- `error` — stable code, readable message, `recoverable` flag.

`speaker` and `cadence` are additive fields on `final`; a client that ignores
them still works, which is why this stays version 1. Breaking audio or event
semantics require version 2 and an explicit browser compatibility check.

## State and commit rules

The browser state machine is:

```text
unsupported | offline → connecting → loading-model → ready
                                      ready → listening ↔ processing
                                      any → error → retry → connecting
```

Only a non-empty `final` crosses into the clinical pipeline. A partial exists
only for immediate feedback. The pipeline emits a typed event, and the reducer
either commits the complete event or records why it did not. Every accepted,
held, refused or ignored final creates an audit entry with its stage trace. This
boundary is what prevents unstable hypotheses from duplicating values.

## Latency budget

Measured from speech onset to structured chart paint on the reference CPU:

| Stage | Target | Enforcement/measurement |
| --- | ---: | --- |
| Capture batch | 100 ms | AudioWorklet `batchMs` |
| Browser + loopback transport | p95 < 30 ms | client send and server receipt telemetry |
| Partial cadence | 700 ms | `ASR_PARTIAL_INTERVAL_MS` |
| End-of-speech silence | 300–1100 ms, adaptive | `server/cadence.py`, reported on every final |
| Tiny.en CPU INT8 final decode | p95 < 700 ms after endpoint | `decodeMs`; hardware dependent |
| Clinical pipeline | p95 < 10 ms | `parserSamples`; gated in `tests/pipeline.test.ts` and the clinical harness |
| Speech onset → chart commit | median < 1.2 s, p95 < 2.0 s | session latency panel and evaluation harness |

Endpoint silence dominates perceived delay, which is why it adapts. Use `tiny.en`
for the CPU demo; promote `base.en` or `small.en` only after accuracy gains are
measured against the resulting tail latency. Avoid larger beams on the
interactive path; the default is greedy with a single serialized model worker.

## Backpressure and concurrency

Each WebSocket has a bounded decode queue. A newly eligible partial replaces a
pending partial, because an older hypothesis has no downstream value. A final
removes pending partials and waits for queue capacity; it is not discarded. The
model adapter holds a decode lock, because concurrent CPU inference increases
tail latency and memory contention on the reference machine.

For more than one simultaneous operatory, replace the in-process lock with a
model-worker pool and an admission controller:

```text
connection sessions → priority queue (final > newest partial) → N model workers
```

Capacity is accepted only if final p95 stays inside the service-level objective;
otherwise return `busy` before capture begins. Do not silently build an unbounded
queue. Audio buffers are per-utterance and capped by `ASR_MAX_UTTERANCE_MS`.

## Observability

No raw audio or transcript is logged. `GET /api/metrics` returns counters and
duration histograms whose names come from a fixed allowlist in
`server/telemetry.py`, so label cardinality is bounded by construction rather
than by convention — an unknown name raises instead of quietly creating a series.
Histogram memory is bounded by a fixed reservoir.

Counters cover connections, streams, utterances, partials, dropped partials,
finals, decode errors, invalid audio, model loads and failures, and the three
speaker outcomes. Histograms cover partial and final decode time, queue wait,
audio and speech duration, the adapted endpoint, and model load time.

The browser keeps its own session counters — charted, filtered as conversation,
held as uncertain, blocked by attribution, refused as stale — plus end-to-end and
clinical-pipeline latency samples.

Exporting to a metrics backend is not implemented. Transcript or audio sampling
would require an explicit consented evaluation mode, encryption, retention expiry
and access audit; clinical content must never become a metric label.

## Failure and recovery behavior

- Model loading is visible and disables microphone start; the first download is
  never presented as a frozen UI. A failed load can be retried over the existing
  socket without restarting the browser.
- WebSocket loss moves the interface to offline, retains the deterministic
  simulator, and reconnects with capped exponential delay.
- A recoverable decode error does not close capture; a model or protocol error
  requires retry or restart.
- Stopping drains the final utterance before `stopped`, then releases tracks,
  nodes, ports and the audio context.
- Invalid binary frames receive `invalid_audio`; audio before `start` receives
  `stream_not_started`.
- Enrolment failure reports why (usually too little speech) and leaves the
  previous profile untouched.
- The chart remains in browser memory if recognition fails. There is no automatic
  replay of buffered clinical audio after reconnect, because replay can create
  stale context writes.

## Privacy and clinical safety boundary

Audio, inference and voice profiles stay on the local machine in the default
profile. The model repository is contacted only to download model artifacts; the
application never sends captured audio to it. Production packaging should
pre-provision verified model artifacts to eliminate runtime network access.

Browser WebSocket origins are allowlisted with `ASR_ALLOWED_ORIGINS`. Production
must set the deployed trusted origin rather than accepting arbitrary websites
that can reach a loopback service.

This prototype has no authentication, encrypted patient store, EHR interface,
regulated audit retention or clinician sign-off, and must not be used for real
patient records. A production commit requires explicit clinician confirmation for
low-confidence or context-changing events, append-only audit storage, role-based
access, encryption in transit and at rest, signed model versions and a rollback
plan. Recognition confidence alone must never override anatomical sequence
validation.

## Deployment profiles

| Profile | Model/device | Use |
| --- | --- | --- |
| Reference demo | `tiny.en`, CPU, INT8 | Lowest setup cost and latency; current default |
| Accuracy evaluation | `base.en`/`small.en`, CPU INT8 | Offline comparison before promotion |
| Workstation | `small.en`, CUDA FP16/INT8 | Only after GPU/driver compatibility and latency tests |
| Packaged clinic | pinned local artifact, no runtime download | Required direction for privacy-controlled deployment |

Configuration is through the `ASR_*` environment variables in `server/config.py`.
Python is pinned to 3.12 for the native inference stack. The web app and API are
same-origin through the Vite proxy in development; production should terminate
TLS and proxy `/api` and `/ws` to the local service.

## Evaluation strategy

Three fixture tiers, described in full in [EVALUATION.md](./EVALUATION.md):

1. Deterministic unit tests for PCM decoding, endpointing, queue policy,
   protocol, every pipeline stage, the reducer and lifecycle cleanup.
2. A real-model smoke fixture with a known transcript, proving the native model
   loads and decodes without mocks, plus the acoustic replay harness.
3. A versioned clinical corpus of charting episodes across eleven cohorts with
   structured ground truth.

Release reports separate word error rate from clinical event exact match, site
alignment error, false chart entry rate, correction success, context success and
latency percentiles. Clinical exact match and false chart entry rate are the
primary product metrics.

## Change discipline

Protocol, model, lexicon, prompt, VAD, preprocessing and corpus versions are
recorded independently. Any change that can alter a chart event must ship with a
before/after evaluation report, latency percentiles, failure examples and
rollback configuration. Fast recognition is useful only when the resulting
structured event is attached to the correct clinical context.

## What is not built

Stated plainly, because the gaps matter more than the features:

- **Recorded operatory audio.** The noise sources are synthesized approximations.
  They support relative comparison between preprocessing profiles on identical
  audio; they are not a claim about a specific clinic. A promotion decision for
  real deployment needs recordings from it.
- **A dental speech corpus.** The acoustic tier uses one public speech fixture.
  The clinical tier evaluates the layer this project contributes, using
  transcripts including recognizer errors, but it does not measure recognition of
  dental speech by accent or speaker, which needs consented recordings.
- **Working speaker attribution.** The classical profile does not separate voices
  at clinical utterance lengths; see stage 1. A trained speaker-embedding model
  behind the same interface is the fix.
- **A recorded dental fixture.** Recognizer comparison currently runs on
  synthesized speech, one voice, no room.
- **Overlapping speech.** Two people talking at once is detected only as a lower
  similarity score, and resolves to `unknown`.
- **A model-worker pool.** One operatory per process.
- **Persistence, authentication, EHR integration, metric export.** None exist.
- **Adapted or fine-tuned recognition for accents or practice vocabulary.** The
  lexicon and the biasing prompt are the whole mechanism today. Fine-tuning would
  require licensed, consented data and a signed model registry, and promotion
  would need stratified clinical accuracy with regression limits per cohort.
