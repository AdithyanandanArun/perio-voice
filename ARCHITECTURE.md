# Perio Voice architecture

## Purpose and constraints

Perio Voice is a local-first, low-latency clinical voice pipeline. The first milestone accepts microphone audio, produces partial and final English transcripts, applies a deterministic periodontal grammar, and commits validated events to an in-memory chart. Speech recognition is deliberately isolated from clinical interpretation so either side can evolve without changing the other contract.

The current release is a prototype, not a medical device. Its safety posture is conservative: partial hypotheses never mutate the chart, invalid or overflowing sequences are rejected atomically, and the simulator remains available if the voice service is unavailable.

## Runtime topology

```text
Browser (React)
  getUserMedia
    → AudioWorklet (mono, resample, 16 kHz PCM16, 100 ms frames)
    → binary WebSocket /ws/asr
        → FastAPI connection/session boundary
        → energy VAD + pre-roll + utterance endpointing
        → bounded latest-partial-wins decode queue
        → Faster-Whisper tiny.en (CPU INT8 by default)
    ← speech_start / partial / final / metrics / error
  final transcript only
    → deterministic clinical engine
    → immutable session reducer
    → live chart + audit history + latency samples

Transcript simulator ───────────────────────────────┘

GET /api/health ← model lifecycle and deployment metadata
```

Component ownership:

- `public/audio/pcm-capture-worklet.js` performs capture-thread resampling, PCM16 conversion, 100 ms batching, transferable-buffer delivery, and input-level measurement.
- `src/speech/useLocalAsr.ts` owns microphone permission, WebSocket lifecycle, reconnects, model states, partial/final handling, and complete resource cleanup.
- `server/audio.py` owns PCM validation, voice activity endpointing, pre-roll, partial cadence, and maximum utterance duration.
- `server/session.py` owns per-stream backpressure and serialized recognition. Pending partials may be superseded; finals are never intentionally dropped.
- `server/recognizer.py` is the inference adapter. It lazy-loads one Faster-Whisper model and keeps CPU decode work off the async event loop.
- `src/domain/clinicalEngine.ts` is pure and ASR-independent. It owns relevance, context, parsing, correction semantics, range checks, and sequence integrity.
- `src/domain/sessionReducer.ts` is the only UI chart-state transition boundary.

## WebSocket protocol v1

The server begins every connection with `hello`, including protocol version and required audio format, followed by `model_status` or `model_ready`. The browser sends UTF-8 JSON control messages and binary audio frames.

Client controls:

```json
{"type":"start"}
{"type":"stop"}
{"type":"ping"}
{"type":"retry_model"}
```

Binary payloads are little-endian signed PCM16, mono, 16,000 Hz. Frames are normally 3,200 bytes (100 ms), but the server validates framing rather than assuming one packet size.

Server events:

- `hello`: protocol and audio contract.
- `model_status` / `model_ready`: lifecycle, model name, device, compute type, sample rate, and safe error text.
- `listening`: the session can accept binary frames.
- `speech_start`: utterance id and server monotonic start time.
- `partial`: replaceable hypothesis plus audio/decode duration and dropped-partial count.
- `final`: commit-eligible transcript, word timestamps, audio/decode duration, and utterance id.
- `stopped`: stream drain is complete.
- `error`: stable code, readable message, and `recoverable` flag.

Protocol additions must be backward compatible within version 1. Breaking audio or event semantics require version 2 and an explicit browser compatibility check.

## State and commit rules

The browser state machine is:

```text
unsupported | offline → connecting → loading-model → ready
                                      ready → listening ↔ processing
                                      any → error → retry → connecting
```

Only a non-empty `final` event crosses into the clinical engine. A partial exists only for immediate feedback. The clinical engine emits a typed event, and the reducer either commits the complete event or rejects it without a partial chart update. Every accepted or rejected final creates an audit entry. This boundary prevents unstable ASR hypotheses from duplicating values.

## Latency budget

The target is responsive charting on the reference CPU, measured from speech onset to structured chart paint:

| Stage | Target | Enforcement/measurement |
| --- | ---: | --- |
| Capture batch | 100 ms | AudioWorklet `batchMs` |
| Browser + loopback transport | p95 < 30 ms | client send and server receipt telemetry (next instrumentation leaf) |
| Partial cadence | 700 ms | `ASR_PARTIAL_INTERVAL_MS` |
| End-of-speech silence | 520 ms | `ASR_END_SILENCE_MS` |
| Tiny.en CPU INT8 final decode | p95 < 700 ms after endpoint | `decodeMs` in every result; hardware dependent |
| Parser + reducer | p95 < 10 ms | browser performance measure |
| Speech onset → chart commit | median < 1.2 s, p95 < 2.0 s | session latency panel and evaluation harness |

Endpoint silence dominates perceived delay, so it must be tuned against clipped final words. Use `tiny.en` for the CPU demo. Promote `base.en` or `small.en` only after accuracy gains are measured against the resulting tail latency. Avoid larger beams on the interactive path; the default is greedy/beam 1 with a single serialized model worker.

## Backpressure and concurrency

Each WebSocket has a bounded decode queue. A newly eligible partial replaces a pending partial because older hypotheses have no downstream value. A final removes pending partials and waits for queue capacity; it is not discarded. The model adapter also has a decode lock because concurrent CPU inference increases tail latency and memory contention on the reference machine.

For more than one simultaneous operatory, replace the in-process lock with a model-worker pool and admission controller:

```text
connection sessions → priority queue (final > newest partial) → N model workers
```

Capacity is accepted only if final p95 stays inside the service-level objective. Otherwise return `busy` before capture begins. Do not silently build an unbounded queue. Audio buffers are per-utterance and capped by `ASR_MAX_UTTERANCE_MS`.

## Observability

No raw audio or transcript is logged by default. Operational events use a random session id and utterance id, never patient identity. The next telemetry adapter should emit:

- model load duration and state transitions;
- captured audio duration, speech duration, endpoint reason, and VAD level summary;
- queue wait, decode time, real-time factor, dropped partials, and final word confidence distribution;
- final-to-parser outcome (`accepted`, `ignored`, `rejected`) and parser duration;
- end-to-end median/p95/p99 latency and reconnect/error counters.

Metrics are bounded-label counters/histograms. Transcript or audio sampling requires an explicit consented evaluation mode, encryption, retention expiry, and access audit. A correlation id should travel in protocol events, but clinical content must not become a metric label.

## Failure and recovery behavior

- Model loading is visible and disables microphone start; the first download is never presented as a frozen UI. A failed load can be retried over the existing socket without restarting the browser.
- WebSocket loss moves the UI to offline, retains the deterministic simulator, and reconnects with capped exponential delay.
- A recoverable decode error does not close capture; a model or protocol error requires retry/restart.
- Stopping drains the final utterance before `stopped`, then releases tracks, nodes, ports, and the audio context.
- Invalid binary frames receive `invalid_audio`; audio before `start` receives `stream_not_started`.
- The chart remains in browser memory if ASR fails. There is no automatic replay of buffered clinical audio after reconnect because replay can create stale context writes.

## Privacy and clinical safety boundary

Audio and inference stay on the local machine in the default profile. The model repository is contacted only to download model artifacts; the application does not send captured audio to it. Production packaging should pre-provision verified model artifacts to eliminate runtime network access.

This prototype has no authentication, encrypted patient store, EHR interface, regulated audit retention, or clinician sign-off. It must not be used for real patient records. A production commit requires explicit clinician confirmation for low-confidence or context-changing events, append-only audit storage, role-based access, encryption in transit/at rest, signed model versions, and a rollback plan. Recognition confidence alone must never override anatomical sequence validation.

## Deployment profiles

| Profile | Model/device | Use |
| --- | --- | --- |
| Reference demo | `tiny.en`, CPU, INT8 | Lowest setup cost and latency; current default |
| Accuracy evaluation | `base.en`/`small.en`, CPU INT8 | Offline comparison before promotion |
| Workstation | `small.en`, CUDA FP16/INT8 | Only after GPU/driver compatibility and latency tests |
| Packaged clinic | pinned local artifact, no runtime download | Required direction for privacy-controlled deployment |

Configuration is through `ASR_MODEL`, `ASR_MODEL_DIR`, `ASR_DEVICE`, `ASR_COMPUTE_TYPE`, and the endpoint/VAD variables in `server/config.py`. Python is pinned to 3.12 for the native inference stack. The web app and API are same-origin through the Vite proxy in development; production should terminate TLS and proxy `/api` and `/ws` to the local service.

Browser WebSocket origins are allowlisted with `ASR_ALLOWED_ORIGINS` (local Vite origins by default). Production must set the deployed trusted origin rather than accepting arbitrary websites that can reach a loopback service.

## Evaluation strategy

Keep three fixture tiers:

1. Pure deterministic tests for PCM decoding, endpointing, queue policy, protocol, parser, reducer, and lifecycle cleanup.
2. A real-model smoke fixture with a known transcript to prove the native model loads and decodes without mocks.
3. Versioned dental evaluation sets containing clean, accented, rapid, corrected, negated, multi-speaker, and operatory-noise audio with structured ground truth.

Release reports should separate word error rate from clinical event exact match, site-alignment error, false chart-entry rate, correction success, context error, and latency percentiles. Clinical exact match and false entry rate are the primary product metrics.

## Post-milestone build order

All later capabilities plug in before the existing atomic reducer commit. Each leaf gets an interface, fixtures, metrics, and a shadow-mode rollout before it can change chart state.

### 1. Irrelevant-speech filtering

Add a `RelevanceClassifier.score(transcript, acoustic, context) -> decision` stage after final ASR and before parsing. Inputs include transcript tokens, utterance duration, ASR confidence, active workflow, and recent accepted events. Outputs are `chartable`, `non_chartable`, or `uncertain` with reasons. Start with rules plus a compact local classifier, run in shadow mode, and optimize false chart entries before recall. Uncertain speech is displayed but not committed.

### 2. Sequence protection

Extend parser output with candidate value spans and confidence. A `SequenceGuard` compares candidate count and alignment with expected sites, rejects insert/delete shifts atomically, and can request confirmation. Add property tests over missing, repeated, and extra values and measure per-site alignment error, not only transcript accuracy.

### 3. Context-aware phonetic disambiguation

Introduce a bounded candidate lattice from ASR alternatives/word scores. `ContextResolver.resolve(candidates, ClinicalContext)` re-ranks only valid tooth, surface, measurement, and command interpretations. It may map `to/too` to `2` while a depth is expected but cannot invent an out-of-range value. Measure ambiguity resolution accuracy and added p95 latency; target < 20 ms.

### 4. Negation handling

Create typed finding assertions with polarity, cue span, scope, and confidence. A deterministic scope parser handles short clinical patterns first; a local language model may only propose candidates behind the same validator. Fixtures cover pauses, double negation, corrections, and conversational negatives. Low-confidence polarity requires confirmation because it reverses clinical meaning.

### 5. Natural corrections and repetitions

Represent accepted events in an append-only utterance/event journal. `CorrectionResolver` targets an event id or bounded recent window and emits a compensating replacement, never an in-place invisible mutation. Add undo/redo semantics, explicit confirmation for ambiguous targets, and tests for self-correction, full-sequence replacement, repeated confirmation, and delayed correction.

### 6. Background-noise robustness

Build a reproducible augmentation and replay harness with suction, handpiece, scaler, chair, HVAC, and babble at recorded SNR bands. Evaluate browser constraints, microphone placement, WebRTC denoising, and optional local enhancement as swappable preprocessing profiles. Promote a profile only if it improves clinical exact match without violating p95 latency or clipping short numbers.

### 7. Multiple-speaker handling

Add timestamp-preserving speaker embeddings/diarization behind `SpeakerGate.accept(words, segments, enrolledClinician)`. Enrollment data stays local and revocable. Unknown or overlapping speakers cannot commit. Evaluate clinician false rejects, non-clinician false accepts, overlap, and speaker handoff; provide a visible manual override rather than hidden attribution.

### 8. Speaking-speed and cadence robustness

Make endpoint thresholds adaptive within safe limits using recent syllable/word cadence and partial stability. Preserve maximum utterance and queue caps. The replay matrix must cover isolated words, rapid grouped values, uneven pauses, and interruptions. Tune for clinical exact match and tail latency separately for cadence bands.

### 9. Context and position recovery

Move workflow state to an explicit state machine with versioned transitions and commands such as skip, back, resume, tooth, surface, and direction. Every ASR final carries the context version observed at speech start; stale finals are rejected instead of written into a newer location. Recovery tests replay interruptions, backward jumps, skipped teeth, and reconnects.

### 10. Dental terminology and accent robustness

Maintain a versioned dental lexicon and per-workflow phrase set, feed supported prompts/hotwords to the recognizer, and evaluate by speaker/accent without storing identity in routine telemetry. Fine-tuning or adapters require licensed, consented data and a signed model registry. Promotion is based on stratified clinical event accuracy with regression limits for every existing cohort.

## Change discipline

Protocol, model, VAD, parser, and clinical-context versions are recorded independently. Any change that can alter a chart event must ship with a before/after evaluation report, latency percentiles, failure examples, and rollback configuration. Fast recognition is useful only when the resulting structured event is attached to the correct clinical context.
