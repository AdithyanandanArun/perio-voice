# Perio Voice

Perio Voice is a local clinical voice intelligence layer for periodontal
charting. Browser microphone audio is streamed as 16 kHz PCM to a local
Faster-Whisper service; final transcripts pass through a deterministic clinical
pipeline that decides what belongs in the chart, what it means, and where it
goes. No audio leaves the machine, and no browser-vendor recognition API is
used. The opt-in developer fixture uses a pinned local Piper TTS voice solely to
replay test prompts through the laptop speakers.

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

With an NVIDIA GPU visible (`/dev/nvidia0` exists), `npm run dev` installs the
`gpu` extra (cuBLAS and cuDNN wheels) and the service runs Whisper `large-v3` on
the card. The first start downloads the ~3 GB `large-v3` artifact into the
ignored `models/` directory and then loads it into about 3.9 GB of video memory.
Without a GPU it downloads `tiny.en` instead and uses the CPU stack. The
interface shows **Loading model** during this; microphone capture becomes
available at **Voice model ready**. Later starts reuse the local artifact.
`GET /api/health` reports which model and device actually loaded.

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

### Safe multi-station auto chart

One normal final is charted through the ordinary low-latency clinical pipeline.
For a deliberate multi-station note, separate complete directives with a
semicolon or a new line:

```text
tooth fourteen buccal depths three four five; tooth fifteen lingual depths two three four
```

This is deterministic NLP — the versioned dental lexicon, context resolver and
typed grammar — not a generative model. The batch is evaluated against a private shadow session
first. Every directive must explicitly name a tooth and surface,
fully parse, be clinically relevant, be free of acoustic ambiguity, and pass the
same range, sequence, correction and stale-context guards as live speech. If any
directive fails, **none** of the note changes the chart, journal or active
location; the audit trail says why. Use ordinary one-station phrases to resolve
an ambiguous word or a correction.

## Which recognizer, and why

On a machine with a usable NVIDIA GPU the service runs **Whisper `large-v3`**
(CUDA, float16) prompted with example transcriptions from
`shared/dental-prompt.json`. Without one it falls back to the CPU stack described
further down.

The choice was made by `scripts/bakeoff.py` on the 138 loudspeaker replay
recordings (69 phrases, quiet and noise passes), scoring each recognizer by what
reaches the chart through the real clinical pipeline rather than by word error
rate:

| recognizer | chart exact | false chart entries | decode p50 / p95 |
| --- | ---: | ---: | ---: |
| `large-v3` + example prompt + speech checks, RTX 4060 | **93.3%** (97/104) | **1/28** | 335 / 373 ms |
| the same, streamed live over `/ws/asr` | **94.2%** (98/104) | 1/29 | endpoint→final 344 / 420 ms |
| grammar-constrained (Vosk), CPU | 54.8% (57/104) | 2/28 | 415 / 617 ms |
| Whisper `tiny.en`, CPU | 53.8% (56/104) | 3/28 | 174 / 209 ms |

Re-measured immediately before this was written. The live row streams every
recording through the running service in 100 ms frames, so the endpointer,
partials and decode queue are all in the path; one extra final (a sound after the
speech) was scored as its own utterance, hence 29. Earlier runs on the same
recordings show where the gain comes from: size alone moved chart accuracy only
to 66–67% (`large-v3`, `large-v3-turbo`, `distil-large-v3` unprompted); on
`large-v3-turbo` a descriptive prompt reached 73% and an example prompt 85%, and
the example prompt on `large-v3` 94%. Large Whisper models
copy the *style* of their prompt as well as its vocabulary, so a prompt that
reads like the transcripts the chart needs ("three four five. buccal. four no
three.") primes both clinical terms and digits spelled as words. `large-v3-turbo`
with the same prompt reached 84.6% at 235 ms median — the option if latency ever
matters more than accuracy. Parakeet-TDT 0.6B on CPU reached 58.7%.

**The prompt has a cost, and the service guards it.** Given noise, a prompted
`large-v3` recites its prompt: endpointed suction, handpiece and scaler bursts
came back as "b o p d three four five." — a bleeding finding and three depths —
and the prompt also pulls Whisper's own no-speech estimate down so far that the
old 0.6 threshold never fires. Three checks now decide whether a segment is
speech before its text can reach the chart: saturated audio (>1% of samples at
full scale) is refused as a capture fault; Silero VAD, which never sees the
prompt, must hear sustained speech; and the no-speech threshold is recalibrated
to 0.15 for the prompted model. On noise realizations the thresholds were not
tuned on, 0 of 249 bursts produce text (`scripts/verify_noise_rejection.py`).
They cost one scenario of 104 on the replay recordings.

The replay recordings are one synthetic Piper voice through the laptop speakers
and microphone. They exercise the real capture path, but these numbers are not
clinician performance; see [EVALUATION.md](./EVALUATION.md).

### CPU fallback

Without a GPU, clinical speech goes to a grammar-constrained recognizer and
free-form speech to Whisper `tiny.en`. That stack was chosen on the 30 synthesized
dental phrases in
`evaluation/fixtures/synthetic-dental/`:

| engine | word error rate | exact match | ms/utterance |
| --- | ---: | ---: | ---: |
| Whisper `tiny.en`, beam 5 | 0.820–0.910 | 33–40% | 280–315 |
| grammar-constrained | **0.132** | **80%** | **167–171** |

These are four immediate runs on the reference CPU after the grammar safety
changes. Whisper's temperature fallback makes its short-utterance result vary;
the grammar result was stable. The grammar previously reached 93% only while
context-specific narrowing could force one legitimate clinical word onto a
different word. Removing that unsafe narrowing deliberately traded raw exact
match for the invariant that the recognizer may abstain but may not substitute.

A larger acoustic model is not available to this approach: `vosk-model-en-us-0.22`
(2.7 GB) refuses runtime grammars outright, so it can only run unconstrained, and
unconstrained is the mode that performs badly (0.211 word error, 73% exact). The
grammar is doing the work, not the model size.

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
Note that on the replay recordings, which cross a real speaker, room and
microphone, the grammar's advantage over `tiny.en` all but disappears (54.8%
against 53.8% chart exact); the table above is why the GPU profile does not use
it.

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

The service picks its recognizer at startup. With a usable GPU — a CUDA device
*and* loadable cuBLAS/cuDNN — it applies the GPU profile:

```bash
ASR_DEVICE=cuda                 # auto (default) | cuda | cpu
ASR_MODEL=large-v3
ASR_COMPUTE_TYPE=float16
ASR_ENGINE=whisper
ASR_WORD_TIMESTAMPS=0           # chart accuracy was measured without them
ASR_SPEECH_PRESENCE_THRESHOLD=0.35   # Silero speech check before decoding; 0 disables
ASR_NO_SPEECH_THRESHOLD=0.15    # recalibrated for the prompted model (0.6 on CPU)
```

Otherwise it keeps the CPU defaults, chosen for low latency on a CPU-only
development machine:

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
ASR_MAX_ALTERNATIVES=4          # competing readings offered to the clinical context
ASR_VAD_RMS_THRESHOLD=0.004     # absolute floor for speech detection
ASR_VAD_MARGIN=3.0              # speech must exceed the tracked noise floor by this
```

Any `ASR_*` variable set explicitly wins over the profile, so
`ASR_DEVICE=cpu npm run dev` restores the CPU stack on a GPU machine and
`ASR_MODEL=large-v3-turbo` trades ten points of chart accuracy for ~95 ms. Only
the service applies the profile; scripts and gates read `Settings.from_env()`,
which keeps the CPU defaults so they behave the same with or without a GPU.

Word timings are off on the GPU because the chart accuracy was measured without
them. They cost ~45 ms median and ~110 ms at p95, and the acoustic-confidence
signal they feed into relevance has never been calibrated against `large-v3`'s
word probabilities.

Speech detection is relative to the room. A fixed threshold has to be chosen for
one microphone at one distance, and measured on real speech the quietest tenth of
genuine frames fell below the old fixed value. The detector now tracks the noise
floor and requires a margin above it; on softly spoken speech that moves detection
from 13% of frames to 46%.

The browser's own noise suppression and automatic gain control are **off**. They
are tuned for voice calls and damage exactly what this depends on — short, quiet,
fricative-initial words like "three" — before any code here sees the audio.

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

### Automated loudspeaker fixture

The developer recorder can create a room-and-device fixture without someone
reading all 138 prompts. It speaks each phrase with the pinned local Piper
en_US-lessac-medium voice,
plays it through the laptop speakers, records it through the microphone and the
same PCM worklet as live recognition, then adds deterministic suction/handpiece
audio during the noise pass. Echo cancellation is disabled only for this replay
profile so the microphone can hear the laptop; normal recognition keeps it on.

Set the laptop speakers to an ordinary conversational volume, then run:

```bash
PERIO_FIXTURE_CAPTURE=1 npm run dev
# Open http://127.0.0.1:5173/?record=1 and select “Record all … with Piper TTS”.

uv run python scripts/evaluate_dental.py \
  --audio-root evaluation/fixtures/dental/audio/tts-replay \
  --json /tmp/tts-replay-transcripts.json
node scripts/evaluate-clinical.mjs --transcripts /tmp/tts-replay-transcripts.json
```

The first inaudible clip stops the run instead of saving silence; raise the
speaker volume and resume. TTS recordings are isolated under the git-ignored
`audio/tts-replay/` tree and cannot overwrite human recordings. This fixture
exercises speakers, room acoustics, microphone, resampling, recognition and the
clinical pipeline. It is still synthetic speech and therefore does not establish
accuracy for clinician voices, accents or a real operatory.

The Piper WAVs are checked in so normal setup remains offline after repository
and ASR-model setup. If the prompt manifest changes, regenerate and re-gate them:

```bash
uv run --with piper-tts python scripts/generate_dental_replay.py
node scripts/verify-acoustic-replay.mjs
```

## Troubleshooting

- **ASR offline:** ensure `npm run dev` is still running and port 8000 is free,
  then select **Retry engine**.
- **Loading model for a long time:** the first artifact is downloading. Check
  terminal output and network access. A failed load appears in `/api/health` and
  in the interface.
- **Microphone permission denied:** allow microphone access for `127.0.0.1` in
  browser site settings, then retry. Capture APIs require localhost or HTTPS.
- **TTS replay is unavailable or silent:** use the laptop speakers rather than
  headphones, raise output to a normal conversational level, keep the microphone
  unobstructed, and confirm `/api/fixture/tts?id=acc-buccle-u01` responds while
  the capture-enabled service is running.
- **No speech detected:** verify the input device and lower
  `ASR_VAD_RMS_THRESHOLD` gradually. Do not set it so low that room noise starts
  utterances.
- **Values are held instead of charted:** open **Held for confirmation** — the
  reason is shown. If everything is being held, a voice profile is enrolled and
  enforcement is on but the microphone is picking up someone else.
- **Enrolment keeps failing:** it needs a few seconds of continuous speech. Read
  a sentence aloud rather than saying one word.
- **Health reports `cpu` on a GPU machine:** check that `/dev/nvidia0` exists,
  that `uv sync --extra gpu` has been run (a plain `uv sync` removes the CUDA
  wheels; `npm run dev` re-adds them), and that `ASR_DEVICE` is not set to `cpu`.
  The service falls back to the CPU rather than fail when cuBLAS or cuDNN will
  not load.
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
