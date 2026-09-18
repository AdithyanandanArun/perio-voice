# Current task — cloud streaming recognition with a local fallback

Updated: 2026-09-18 by the Claude Code driver (Opus 5), handing off because the
session ran out of limits. Read `CLAUDE.md` first, then this file.

## Why this task exists

The owner's competitors chart periodontal exams in **under one second** with
better precision using **cloud** speech recognition. Our local recognizer
(Whisper `large-v3` on the RTX 4060) is accurate (94.2% chart exact on the
replay recordings) but slow in *perceived* latency, because Whisper is a batch
model: the service waits ~520 ms of trailing silence, then decodes the whole clip
(~300 ms). Streaming cloud recognizers transcribe while you speak and finalize
after a short pause.

The owner chose **Deepgram** (free: $200 credit on signup, no card).
Goal: add a **streaming cloud engine (Deepgram `nova-3-medical`)**, keep local
`large-v3` as the automatic **offline fallback**, and adopt cloud as the default
only if measurements show it wins. The clinical pipeline (relevance, context,
sequence guard, corrections, no false entries) is the product and stays
untouched — the recognizer is replaceable by design.

## Repository state — read before touching anything

- **Branch `main` at `db9e259`** — a revert commit whose tree is byte-identical
  to `1764d76`. At the owner's request it undoes Hrishinandan's five commits
  `99ac6a9..bfe9562` (int8_float16 "4 GB" GPU profile, shortened capture,
  endpoint/warmup/transaction changes), which were degrading recognition.
  **Not pushed.** `origin/main` still has those commits. Ask the owner before
  pushing — it undoes a teammate's pushed work. Never force-push.
- **Uncommitted on `main`:** `.gitignore` (now ignores `.env`, `.env.*`, keeps
  `!.env.example`) and `GATES.md` (Milestone 8, gates G50–G54, all open), plus
  this file. The owner's standing rule is to commit logically and often; commit
  these when you start (message explains *why*, **no Co-Authored-By trailer**).
- **Branch `backup/latency-milestone-2026-09-18` at `976888d`** — the abandoned,
  *unverified* latency milestone (Codex + Sonnet workers + driver fixes, 31
  files) that was uncommitted when the owner asked for the rollback. Don't merge
  it. Useful only as reference; its findings are summarised below.
- The owner's **`npm run dev` is running** (`:8000` backend, `:5173` web app) and
  holds ~4 GB of GPU memory with `large-v3` · cuda · float16. It hot-reloads on
  file changes under `server/`, so a half-written server file will crash it.
  Do not stop it without asking. Never run two GPU jobs at once.
- `scratch/` is the owner's untracked directory. Never edit, add or commit it.

## The API key

- In `/home/adithyan/Documents/DSOLVE/.env` as **`API_KEY=...`** (a Deepgram key,
  40 chars). Validated: `GET https://api.deepgram.com/v1/projects` → HTTP 200, 1
  project. `.env` is git-ignored and untracked.
- Read it from env `DEEPGRAM_API_KEY`, else `API_KEY`, else by parsing `.env`
  (plain `KEY=VALUE`, strip quotes; no new dependency).
- **Never print, log, commit, return in `/api/health`, send to the browser, or
  put in exception text.** Never paste it into chat.
- Only send synthetic audio to Deepgram: `evaluation/fixtures/dental/audio/tts-replay/**`
  (one Piper TTS voice) or synthesized noise. **Never send
  `evaluation/fixtures/dental/audio/quiet/**`** — those are the owner's own
  recordings (the three there are broken, saturated captures anyway).

## What was measured about Deepgram (pre-recorded API, 4 replay clips)

| clip | nova-3-medical | nova-3 (general) |
| --- | --- | --- |
| acc-tree-u01 | `three four five` (conf 1.00) | `three four five` |
| acc-buccle-u01 | `buccal` (0.85) | `bubble` (0.64) |
| neg-positive-u01 | `bleeding` (0.92) | `bleeding` |
| amb-homophones-u01 | `two four eight` (0.99) | `two four eight` |

- With **default options it writes numbers as words** — the form the pipeline
  reads. Do **not** enable `smart_format`, `numerals` or `punctuate`.
- Use the medical model; the general one misheard `buccal`.
- Pre-recorded round trips were 1.4–1.9 s per whole clip (upload + batch from
  India). That is **not** streaming latency — streaming must be measured live.
- Keyterm boosting: use exactly this curated list (not the whole grammar
  vocabulary — that would boost everyday words like "again", "right", "sorry"
  and make casual speech look clinical): buccal, lingual, palatal, mesial,
  distal, facial, labial, mesiobuccal, distobuccal, furcation, suppuration,
  calculus, plaque, bleeding, probing, recession, mobility, gingival,
  attachment, millimeters, exudate, purulent, biofilm, tartar, quadrant,
  margin, depth, depths, tooth.

## The work — acceptance gates already written (project `GATES.md`, Milestone 8)

| Gate | Outcome | Check |
| --- | --- | --- |
| G50 | nova-3-medical on every replay recording: ≥94/104 chart cases, ≤2 false entries | `uv run python scripts/evaluate_cloud.py --gate` → `CLOUD_ACCURACY_GATE_PASSED` |
| G51 | streamed live through the service's cloud engine at real time: ≥94/104, ≤2 false, ≤3 splits, last-voice→final p95 < 1000 ms | `uv run python scripts/verify_live_recognizer.py --engine cloud --gate` → `LIVE RECOGNIZER PASS nova-3-medical` |
| G52 | cloud unreachable / 401 / timeout → the utterance finishes on the local recognizer, flagged; nothing charted from failed or partial cloud text | `uv run pytest -q tests/server/test_cloud_recognizer.py` → ≥6 passed |
| G53 | noise bursts and saturated captures never become text on the cloud engine | `uv run python scripts/verify_noise_rejection.py --engine cloud` → `NOISE_REJECTION_GATE_PASSED` |
| G54 | the key cannot reach git (.env ignored + untracked; no tracked file contains the key) | `node scripts/verify-secrets.mjs` → `SECRETS_GATE_PASSED` |

None of those scripts/tests exist yet. Gates were written before implementation
on purpose; do not weaken a threshold to make one pass — if the product misses,
report the numbers.

### Part A — accuracy and key safety (small)

1. `scripts/evaluate_cloud.py`: reuse `scripts/bakeoff.py` + `scripts/evaluate_dental.py`
   (`evaluate_configuration`, `load_manifest`, `discover_audio`, `RuntimeConfig`,
   bakeoff's `Segment`/`chart_score`). Wrap Deepgram pre-recorded
   (`POST https://api.deepgram.com/v1/listen?model=nova-3-medical&language=en&keyterm=...`,
   header `Authorization: Token <key>`, body = WAV) as a `model_factory`. `--gate`:
   all 138 recordings present, chart ≥94/104, false ≤2. Keep transcripts under
   `evaluation/results/cloud/` (git-ignored). Label round-trip timing
   "upload round trip — not streaming latency". Also run `--model nova-3` for
   comparison. Optionally add `deepgram-medical`/`deepgram-general` candidates to
   `bakeoff.py` that import this client.
2. `scripts/verify-secrets.mjs`: pure-function checks with in-memory negative
   controls (a planted fake key in a fake tracked file is flagged; a non-ignored
   `.env` is flagged). Never print the key.

### Part B — streaming engine and fallback (the main work)

1. `server/cloud_recognizer.py`, `Engine.CLOUD` in `server/routing.py`,
   config/`service_settings()` wiring, `/api/health` (engine `cloud`, model
   `nova-3-medical`, device `cloud`, connection status — never the key). Opt-in via
   `ASR_ENGINE=cloud` until measured. The service may load `ASR_*` defaults from
   `.env` **without overriding** real environment variables.
2. One Deepgram live stream per `AsrSession`
   (`wss://api.deepgram.com/v1/listen`, `encoding=linear16`, `sample_rate=16000`,
   `channels=1`, `interim_results`, `endpointing`, keyterms). Forward every PCM
   frame as it arrives. **Keep the repo's own segmenter as the authority on
   utterance boundaries** (identity, cadence, speech-presence checks, telemetry
   unchanged): on our endpoint send `{"type":"Finalize"}` and use the Deepgram
   final covering that utterance as the terminal text. Interim text may drive
   `partial` messages only (partials never chart). Deepgram's own endpointing
   may be used only if measured to cut latency without more splits or lost
   accuracy.
3. Fallback: connect failure, 401/403, dropped stream, or no final within ~1.5 s
   of Finalize → transcribe the buffered utterance locally; final carries
   `engine: "whisper"`, `fallback: true`; telemetry counts it; interim cloud text
   never becomes a final. Reconnect with backoff; never block the event loop.
4. `server/speech_presence.py` checks (saturation, Silero, no-speech) must still
   gate every final on the cloud path.
5. Tests in `tests/server/test_cloud_recognizer.py` with a fake Deepgram, no
   network (≥6): key precedence and non-leakage; frames forwarded; Finalize on
   endpoint; fallback on connect failure / 401 / timeout / mid-utterance
   disconnect; `.env` does not override real env.
6. `scripts/verify_live_recognizer.py --engine {local,cloud}` (default `local`
   must behave exactly as today, so project gate **G44** keeps its meaning; set
   `ASR_ENGINE` explicitly for the service subprocess, never inherit it from
   `.env`). Cloud: `ASR_DEVICE=cpu` (fallback = tiny.en, no GPU), real-time speed
   1.0, and a **recognizer-agnostic client-side latency**: monotonic time the
   last voiced frame was sent → final arrival. Cloud `--gate` also requires
   **zero fallbacks** (otherwise it measured tiny.en). Print the same client-side
   numbers for `--engine local` so engines can be compared.
7. `scripts/verify_noise_rejection.py --engine cloud`: zero texts with checks on;
   report the ungated count as evidence (the ungated "clinical text" control
   exists because *prompted Whisper* recites its prompt on noise).

### Part C — decide (driver work)

With the owner's dev server stopped (ask first), run `--engine local` on the
GPU and `--engine cloud`, compare chart accuracy, false entries, splits and
client-side last-voice→final p50/p95, and report. Make cloud the default only if
it wins; then update README / ARCHITECTURE / EVALUATION (privacy posture changes
from "fully local" to "cloud-first, works offline"; a real clinic needs a vendor
BAA) and re-verify the whole ledger.

## Unlazy pipeline state

- Scope **`.unlazy/cloud-asr/`**: `PLAN.md`, `gates/leaf-1.1.md` (Part A),
  `gates/leaf-1.2.md` (Part B). Wave `ready-1` launched both as Sonnet 5 subagents;
  the owner stopped both before they wrote anything. Both returned, **no leaf
  verified, no leases held**. To resume, claim again and open a new wave
  (`ready-2`), or work solo and verify against the project gates.
- Scope `.unlazy/latency-quality/` is **abandoned** (the rollback removed its
  milestone from `main`). Leave it.
- Tooling: `node ~/.claude/skills/unlazy/scripts/gate-check.mjs`.
  Approvals bind the exact `PATH`; `--approve` skips gates already marked met — use
  `--approve --reverify` to force re-execution. Evidence binds a gate's
  definition, not the scripts it calls: `--reverify` after changing scripts.

## Owner preferences (durable)

- No `Co-Authored-By` / Claude attribution in commits or PR text, ever.
- Commit logically and often; messages explain what was wrong, the evidence, the
  trade-off. Push only when asked for anything touching a teammate's history.
- The owner asked for coding to go to **Sonnet 5 subagents** with the driver
  verifying (the host cannot enforce reasoning effort — say so, don't claim it).
  Workers must never run `git stash/reset/checkout/restore/commit` (a worker ran
  `git stash` mid-wave last session and put concurrent work at risk), never touch
  `scratch/`, never use the GPU while the dev server holds it.
- Measure before claiming; state what a number does *not* establish (the replay
  corpus is one synthetic voice). Plain, honest status reports.

## Lessons from the abandoned latency milestone (on the backup branch)

- A "fast endpoint" hint that relied on Vosk finals never fired: Vosk's own
  endpointer needs 500 ms of trailing silence (`endpoint.rule2.min-trailing-silence=0.5`
  in the lgraph `model.conf`; installed vosk has no `SetEndpointer*` API). Live:
  semantic endpoints on 2/108 chartable finals; endpoint→final p95 571 ms.
- Shortening the endpoint risks splitting a slow "three… four… five" speaker —
  any latency change must keep splits ≤3 and chart ≥98/104 on the live gate.
- Prompted Whisper recites its prompt on noise ("b o p d three four five");
  that's why the speech-presence checks exist. Keep them on every path.

## Open questions for the owner

1. Push the revert `db9e259` to GitHub?
2. Resume the cloud work (subagents or solo)? Both subagents were stopped by the
   owner without explanation — confirm before relaunching.
