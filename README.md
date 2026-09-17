# Perio Voice

Perio Voice is a working local voice-to-chart prototype for periodontal capture. Browser microphone audio is streamed as 16 kHz PCM to a local Faster-Whisper service; final transcripts pass through a deterministic clinical engine and become validated tooth/surface records. Browser-vendor speech recognition is not used.

The current milestone includes:

- active local `tiny.en` speech recognition on CPU INT8;
- partial and final transcripts over a binary WebSocket protocol;
- visible offline, model-loading, ready, listening, processing, and recovery states;
- tooth, surface, measurement, expected-count, and sequence-position context;
- three-site probing depths, bleeding/negation, corrections, sequence replacement, and atomic guards;
- live chart, audit history, decode/end-to-end latency, simulator fallback, and automated real-model verification.

This is a technical prototype, not a medical device. Do not use it for patient records.

## Quick start

Requirements:

- Node.js 20.19+ (or 22.12+) and npm;
- `uv` (it installs the pinned Python 3.12 runtime and environment);
- a modern browser with `getUserMedia`, AudioWorklet, and WebSocket support;
- internet access for the first model download only.

```bash
npm install
npm run setup
npm run dev
```

Open `http://127.0.0.1:5173`. The single development command starts both the local ASR API on port 8000 and Vite on port 5173, proxies `/api` and `/ws`, and shuts both processes down on Ctrl+C.

### First model start

The first start downloads the Faster-Whisper `tiny.en` artifact into the ignored `models/` directory. The interface shows **Loading model** during this operation; microphone capture becomes available when it shows **Voice model ready**. Later starts reuse the local artifact.

Allow microphone access when prompted, select **Start listening**, and say `three four five`. Only final ASR results update the chart. Partial text is feedback and cannot create duplicate values.

The transcript simulator always remains available and calls the same clinical parser/reducer as a final ASR result.

## Runtime endpoints

- `GET /api/health` returns model status, model name, device, compute type, and sample rate.
- `WS /ws/asr` accepts JSON `start`/`stop` controls and little-endian mono PCM16 binary audio, then emits model, speech, partial, final, metrics, stop, and error messages.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the complete protocol, latency budget, backpressure policy, deployment profiles, observability plan, privacy boundary, and the implementable build order for later clinical-voice problems.

## Supported clinical phrases

| Intent | Examples | Structured effect |
| --- | --- | --- |
| Grouped depths | `three four five`, `depths 3 4 5` | Fills remaining ordered sites |
| Contextual homophones | `to for ate` | Resolves to `2 / 4 / 8` when depths are expected |
| One depth | `three` | Fills only the next site |
| Finding | `bleeding`, `no bleeding` | Sets bleeding polarity |
| Last-value correction | `four no three`, `correct that to three` | Replaces the last filled site without advancing |
| Sequence replacement | `repeat that three four four` | Atomically replaces all three active depths |
| Tooth context | `tooth fifteen` | Moves to tooth 15 |
| Corrected tooth | `tooth fourteen sorry fifteen` | Uses the final corrected tooth |
| Surface context | `buccal`, `lingual`, `tooth sixteen lingual` | Moves to that surface/context |

Depths must be 1–12 mm and tooth numbers 1–32. Values are converted only when the whole utterance fits the conservative charting grammar. Extra depths are rejected as a unit, preventing a single insertion from shifting later sites.

## Configuration

The default is chosen for low latency on a CPU-only development machine:

```bash
ASR_MODEL=tiny.en
ASR_DEVICE=cpu
ASR_COMPUTE_TYPE=int8
ASR_MODEL_DIR=models
```

Endpoint behavior can be tuned with `ASR_VAD_RMS_THRESHOLD`, `ASR_PRE_ROLL_MS`, `ASR_MIN_SPEECH_MS`, `ASR_END_SILENCE_MS`, `ASR_PARTIAL_INTERVAL_MS`, `ASR_MAX_UTTERANCE_MS`, and `ASR_DECODE_QUEUE_SIZE`. Change these only with replay/evaluation evidence; shorter silence improves latency but can clip natural pauses.

Browser WebSockets are restricted to the local Vite origins by default. Set a comma-separated
`ASR_ALLOWED_ORIGINS` list when deploying behind a different trusted origin.

## Verification

The complete quality suite is:

```bash
node scripts/verify-quality.mjs
```

The non-mocked inference smoke test loads the real local model, recognizes the checked-in JFK speech fixture, validates expected words and word timestamps, and prints its decode time:

```bash
uv run python scripts/verify_model_runtime.py
```

The Unlazy acceptance ledger is `GATES.md`. Individual gate scripts cover server framing/endpointing/backpressure, the WebSocket API, browser capture/resampling/reconnect/cleanup, ASR-to-chart behavior, unified startup/shutdown, clinical regressions, accessibility states, documentation, and the real model.

## Troubleshooting

- **ASR offline:** ensure `npm run dev` is still running and port 8000 is free, then select **Retry engine**.
- **Loading model for a long time:** the first model artifact is downloading. Check terminal output and network access. A failed load appears through `/api/health` and the UI.
- **Microphone permission denied:** allow microphone access for `127.0.0.1` in browser site settings, then retry. Capture APIs require localhost or a secure HTTPS context.
- **No speech detected:** verify the input device and lower `ASR_VAD_RMS_THRESHOLD` gradually. Do not set it so low that room noise starts utterances.
- **CPU decoding is slow:** keep `tiny.en`, CPU, and INT8. Close other heavy workloads before evaluating latency.
- **Ports already in use:** stop the process using 5173 or 8000; the development command intentionally fails instead of attaching to an unknown service.

## Project boundaries

`src/speech/` and `server/` implement transport and recognition. `src/domain/clinicalEngine.ts` remains pure and vendor-independent, `src/domain/sessionReducer.ts` is the chart transition boundary, and `src/App.tsx` renders state without parsing clinical language. This separation is the foundation for adding noise robustness, relevance, speaker attribution, context recovery, and terminology models without making ASR responsible for clinical truth.
