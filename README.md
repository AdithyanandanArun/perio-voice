# Perio Voice

Perio Voice is a local clinical voice intelligence layer for periodontal
charting. Browser microphone audio is streamed as 16 kHz PCM to a local
Faster-Whisper service; final transcripts pass through a deterministic clinical
pipeline that decides what belongs in the chart, what it means, and where it
goes. No audio leaves the machine, and no browser-vendor speech API is used.

The point is not the transcription. It is the layer between recognition and the
record:

- **conversation stays out of the chart** — patient-directed speech, requests,
  small talk and practice logistics are scored and filtered, and anything
  borderline is held for your decision instead of guessed;
- **ambiguous words resolve against the active context** — "to for ate" becomes
  2 / 4 / 8 while depths are expected, and cannot become a value the context has
  no room for;
- **grouped values cannot drift** — a group is accepted or rejected whole, so one
  inserted or dropped number never shifts every following site;
- **corrections replace, they do not append** — "four, no, three" rewrites the
  value it meant, and the journal keeps what it replaced;
- **polarity is parsed, not pattern-matched** — "no bleeding or suppuration"
  negates both, and constructions English itself leaves ambiguous are confirmed
  rather than reversed silently;
- **position is explicit** — 64 stations across the mouth with skip, back, resume
  and stale-context protection, so a value cannot land where you have already
  left;
- **the recognizer is given the vocabulary** — while the chart waits for probing
  depths the decoder can emit little but digits, so "for" cannot arrive where
  four was meant and a handpiece cannot become "Bye bye.";
- **every decision is explainable** — each audit entry opens to the stage that
  made it.

This is a technical prototype, not a medical device. Do not use it for patient
records.

## Quick start

Requirements:

- Node.js 20.19+ (or 22.12+) and npm;
- `uv` (it installs the pinned Python 3.12 runtime and environment);
- a modern browser with `getUserMedia`, AudioWorklet and WebSocket support;
- internet access for the first model download only.

```bash
npm install
npm run setup
npm run dev
```

`npm run setup` installs the Python environment and downloads the grammar
recognizer model (~128 MB) into `models/`.

Open `http://127.0.0.1:5173`. The single development command starts the local ASR
API on port 8000 and Vite on port 5173, proxies `/api` and `/ws`, and shuts both
processes down on Ctrl+C.

### First model start

The first start downloads the Faster-Whisper `tiny.en` artifact into the ignored
`models/` directory. The interface shows **Loading model** during this; microphone
capture becomes available at **Voice model ready**. Later starts reuse the local
artifact.

Allow microphone access, select **Start listening**, and say `three four five`.
Only final results reach the chart — partial text is feedback and cannot create a
duplicate value. The transcript simulator always remains available and calls the
same pipeline.

## Supported clinical speech

| Intent | Examples | Structured effect |
| --- | --- | --- |
| Grouped depths | `three four five`, `depths 3 4 5` | Fills the remaining ordered sites |
| Single depth | `three` | Fills only the next site |
| Contextual homophones | `to for ate`, `tree free five` | Resolves to `2 / 4 / 8`, `3 / 3 / 5` when depths are expected |
| Named site | `mesial buccal four`, `distal buccal five` | Writes that site directly |
| Recession | `gingival recession zero one two` | Records recession instead of depths |
| Findings | `bleeding`, `suppuration`, `plaque`, `tartar`, `b o p` | Sets the finding present |
| Negation | `no bleeding`, `without bleeding`, `no bleeding or suppuration` | Sets polarity, across conjunctions |
| Graded findings | `mobility two`, `furcation class three`, `grade two mobility` | Records the tooth-level grade |
| Last-value correction | `four no three`, `correct that to three`, `i meant three` | Replaces the last value without advancing |
| Sequence replacement | `repeat that three four four` | Atomically replaces all three active values |
| Tooth context | `tooth fifteen`, `tooth forty` | Moves to tooth 15, 14 |
| Corrected tooth | `tooth fourteen sorry fifteen` | Uses the corrected tooth |
| Surface and quadrant | `buccal`, `lingual`, `palatal`, `lower left` | Moves context |
| Workflow | `next tooth`, `go back`, `skip this tooth`, `resume` | Moves through the mouth |
| Undo | `undo that`, `scratch that`, `redo` | Reverses or reinstates the last write |

Depths are 1–12 mm, recession 0–12 mm, tooth numbers 1–32, and grades 0–3. Values
are converted only when the whole utterance fits the charting grammar; an extra
value is rejected as a unit, which is what prevents a single insertion from
shifting later sites.

## Which recognizer, and why

Measured on the 30 spoken dental phrases in
`evaluation/fixtures/synthetic-dental/`:

| engine | word error rate | exact match | ms/utterance |
| --- | ---: | ---: | ---: |
| Whisper `tiny.en`, beam 5 | 0.787 | 40% | 272 |
| grammar-constrained | **0.060** | **93%** | **163** |

Whisper size does not fix this. Across `tiny.en`, `base.en`, `distil-small.en`
and `small.en`, exact match on these phrases sits between 23% and 30%, and
`base.en` scores *below* `tiny.en`. The problem is not capacity: a thirty-second
sequence model is being asked to resolve a half-second command with no context,
and it hallucinates confident words on short audio at every size.

Giving the recognizer the vocabulary changes the shape of the problem. Inside a
grammar the decoder chooses between the words a clinician could actually be
saying, so the dominant failures stop being possible rather than merely unlikely.
Speech that fits nothing returns an unknown marker, which is far more useful than
a confident wrong answer.

Whisper remains for free-form dictation, where an open vocabulary is the point.

## Runtime endpoints

- `GET /api/health` — model status, name, device, compute type, sample rate, the
  runtime contract (protocol, prompt version, preprocessing profile, endpoint
  band) and enrolment state.
- `GET /api/metrics` — bounded counters and duration histograms. No transcripts,
  no audio, no identifiers.
- `GET /api/speaker` — enrolment state and configured thresholds.
- `POST /api/speaker/enroll` — raw PCM16 body; adds a sample to the local voice
  profile.
- `POST /api/speaker/reset` — revokes the profile immediately.
- `WS /ws/asr` — JSON `start`/`stop`/`context`/`ping`/`retry_model` controls and
  little-endian mono PCM16 audio; emits model, speech, partial, final, metrics,
  stop and error messages.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the pipeline design, protocol,
latency budget, backpressure policy, observability, privacy boundary, deployment
profiles and an explicit list of what is not built.

## Configuration

The defaults are chosen for low latency on a CPU-only development machine:

```bash
ASR_ENGINE=auto                 # auto | grammar | whisper
ASR_MODEL=tiny.en               # open-vocabulary fallback
ASR_BEAM_SIZE=5
ASR_DEVICE=cpu
ASR_COMPUTE_TYPE=int8
ASR_MODEL_DIR=models
ASR_GRAMMAR_MODEL_DIR=models/vosk-model-en-us-0.22-lgraph
ASR_DENOISE_PROFILE=none        # none | highpass | spectral
ASR_NO_SPEECH_THRESHOLD=0.6     # above this a final is refused as non-speech
ASR_MIN_FINAL_MS=250            # shorter audio is not decoded at all
```

`auto` routes by clinical context: the grammar recognizer answers while the chart
is waiting for clinical values, and Whisper answers when the vocabulary has to
stay open. `grammar` and `whisper` pin one engine, which is how the two are
compared.

Endpointing is adaptive within a band. `ASR_END_SILENCE_MS` is the starting
point; `ASR_MIN_END_SILENCE_MS` and `ASR_MAX_END_SILENCE_MS` bound it, and
`ASR_CADENCE_ADAPTIVE=false` pins it. Also tunable:
`ASR_VAD_RMS_THRESHOLD`, `ASR_PRE_ROLL_MS`, `ASR_MIN_SPEECH_MS`,
`ASR_PARTIAL_INTERVAL_MS`, `ASR_MAX_UTTERANCE_MS`, `ASR_DECODE_QUEUE_SIZE`.
Change these only with replay evidence; shorter silence improves latency but can
clip natural pauses.

Speaker attribution is **off by default and does not currently work**; see
[EVALUATION.md](./EVALUATION.md#speaker-attribution-does-not-separate-speakers).
Enrollment and short-utterance handling were repaired, but the underlying
profile does not distinguish voices at clinical utterance lengths, so leave
`requireSpeaker` off. Its settings are `ASR_SPEAKER_ACCEPT`,
`ASR_SPEAKER_REJECT`, `ASR_SPEAKER_MIN_MS`, `ASR_SPEAKER_ENROLL_MS` and
`ASR_SPEAKER_WINDOW_MS`.

Browser WebSockets are restricted to the local Vite origins. Set a comma-separated
`ASR_ALLOWED_ORIGINS` when deploying behind a different trusted origin.

## Verification

The complete quality suite — Python and TypeScript linting, strict type checks,
every test, and the production build:

```bash
node scripts/verify-quality.mjs
```

The non-mocked inference smoke test loads the real local model, recognizes the
checked-in speech fixture, validates expected words and word timestamps, and
prints its decode time:

```bash
uv run python scripts/verify_model_runtime.py
```

`GATES.md` is the acceptance ledger. Every gate names the single command that
decides it, covering server framing and endpointing, the WebSocket API, browser
capture and cleanup, the dental lexicon, relevance filtering, disambiguation,
negation, corrections and undo, sequence protection, workflow position, speaker
attribution, cadence adaptation, both evaluation harnesses, the assembled
pipeline, the interface, telemetry and this documentation.

## Evaluation

```bash
node scripts/evaluate-clinical.mjs          # chart-level metrics across 11 cohorts
uv run python scripts/evaluate_acoustic.py  # word error rate under operatory noise
```

Word error rate and clinical accuracy are reported separately, because a
word-perfect transcript can still produce a wrong chart.
[EVALUATION.md](./EVALUATION.md) has the corpus, the thresholds, the current
numbers and — importantly — what they do and do not establish.

## Troubleshooting

- **ASR offline:** ensure `npm run dev` is still running and port 8000 is free,
  then select **Retry engine**.
- **Loading model for a long time:** the first artifact is downloading. Check
  terminal output and network access. A failed load appears in `/api/health` and
  in the interface.
- **Microphone permission denied:** allow microphone access for `127.0.0.1` in
  browser site settings, then retry. Capture APIs require localhost or HTTPS.
- **No speech detected:** verify the input device and lower
  `ASR_VAD_RMS_THRESHOLD` gradually. Do not set it so low that room noise starts
  utterances.
- **Values are held instead of charted:** open **Held for confirmation** — the
  reason is shown. If everything is being held, a voice profile is enrolled and
  enforcement is on but the microphone is picking up someone else.
- **Enrolment keeps failing:** it needs a few seconds of continuous speech. Read
  a sentence aloud rather than saying one word.
- **CPU decoding is slow:** keep `tiny.en`, CPU and INT8. Close other heavy
  workloads before evaluating latency.
- **Ports already in use:** stop the process using 5173 or 8000; the development
  command fails deliberately instead of attaching to an unknown service.

## Project boundaries

`src/speech/` and `server/` implement transport and recognition. `src/domain/` is
the clinical pipeline: pure, vendor-independent, and the only place clinical
meaning is decided. `src/domain/sessionReducer.ts` is the single chart transition
boundary, and `src/components/` renders state without parsing clinical language.

That separation is what made it possible to add relevance, disambiguation,
negation scope, corrections, sequence protection and position recovery without
making the recognizer responsible for clinical truth — and it is what would make
it possible to replace the recognizer without touching any of them.
