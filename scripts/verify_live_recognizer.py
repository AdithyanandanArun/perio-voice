"""Streams the replay recordings through the running service, as the browser does.

The bake-off decodes each recording whole. The live service never sees a whole
recording: the browser streams 100 ms PCM frames, the energy endpointer decides
where an utterance starts and stops, partial decodes compete with finals for the
one model, and only then does a final reach the chart. Any of those can cut
"three four five" into "three" and "four five", or delay a final behind a stale
partial, and none of it is visible to a whole-clip decode.

This starts the real service in a subprocess with no ASR_* overrides, so it runs
whatever `service_settings()` selects on this machine, and streams every replay
recording over /ws/asr at a fixed multiple of real time. The finals are scored
through the real clinical pipeline as the bake-off scores transcripts, except
that a recording which produced several finals is replayed as several
utterances, because that is what the pipeline receives.

Latency is measured from the server's endpoint timestamp to the moment the final
arrives at the client, which is queue wait behind a partial plus decode plus
transport. Both processes read CLOCK_MONOTONIC, so the two timestamps compare.

Streaming faster than real time is the pessimistic direction: partials are
requested more often per wall-clock second, so finals queue behind them more.

    uv run --extra gpu python scripts/verify_live_recognizer.py --gate
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import statistics
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from bakeoff import MANIFEST, REPLAY_ROOT, Segment, chart_score  # noqa: E402
from evaluate_dental import (  # noqa: E402
    RuntimeConfig,
    discover_audio,
    evaluate_configuration,
    load_manifest,
)

PORT = 8765
FRAME_MS = 100
SAMPLE_RATE = 16_000
TRAILING_SILENCE_MS = 1_500
READY_TIMEOUT_S = 300

# What the service must be running for this to be a check of the shipped
# recognizer rather than of whatever happened to load.
EXPECTED_MODEL = "large-v3"
EXPECTED_DEVICE = "cuda"

# The whole-clip bake-off measured 94.2% chart exact with 1/28 false entries;
# the live path may lose a little to endpointing but not the margin that made
# large-v3 worth adopting. 700 ms is the documented final-decode p95 budget; this
# adds queue wait and transport on top of decode, so it is the stricter reading.
GATE_MIN_CHART = 0.90
GATE_MAX_FALSE = 2
GATE_MAX_SPLIT = 3
GATE_MAX_P95_MS = 700


class LiveStats:
    def __init__(self) -> None:
        self.latencies_ms: list[float] = []
        self.decode_ms: list[int] = []
        self.split: list[str] = []
        self.finals: list[list[str]] = []
        """The non-empty finals of each recording, in decode order."""
        self.partials = 0
        self.dropped_partials = 0


class LiveServiceModel:
    """Looks like a faster-whisper model; each transcribe() is one live stream."""

    def __init__(self, url: str, speed: float, stats: LiveStats) -> None:
        self.url = url
        self.speed = speed
        self.stats = stats

    def transcribe(self, audio: Any, **_options: object) -> tuple[list[Segment], None]:
        finals = asyncio.run(self._stream(np.asarray(audio, dtype=np.float32)))
        texts = [str(item["text"]).strip() for item in finals if str(item["text"]).strip()]
        self.stats.finals.append(texts)
        if len(texts) > 1:
            self.stats.split.append(" | ".join(texts))
        probability = max((float(item.get("noSpeechProb", 0.0)) for item in finals), default=0.0)
        return [Segment(text=" ".join(texts), no_speech_prob=probability)], None

    async def _stream(self, audio: np.ndarray) -> list[dict[str, Any]]:
        import websockets

        pcm = (np.clip(audio, -1.0, 1.0) * 32_767).astype("<i2")
        frame = SAMPLE_RATE * FRAME_MS // 1_000
        silence = np.zeros(SAMPLE_RATE * TRAILING_SILENCE_MS // 1_000, dtype="<i2")
        samples = np.concatenate([pcm, silence])
        frames = [samples[i : i + frame].tobytes() for i in range(0, len(samples), frame)]
        finals: list[dict[str, Any]] = []
        async with websockets.connect(self.url, max_size=None) as socket:
            await _expect(socket, "model_ready")
            await socket.send(json.dumps({"type": "start"}))
            await _expect(socket, "listening")

            async def receive() -> None:
                async for raw in socket:
                    arrived = time.monotonic() * 1_000
                    message = json.loads(raw)
                    kind = message.get("type")
                    if kind == "partial":
                        self.stats.partials += 1
                    elif kind == "final":
                        finals.append(message)
                        if str(message.get("text", "")).strip():
                            self.stats.latencies_ms.append(arrived - float(message["endedAtMs"]))
                            self.stats.decode_ms.append(int(message["decodeMs"]))
                    elif kind == "stopped":
                        self.stats.dropped_partials += int(message.get("droppedPartials", 0))
                        return
                    elif kind == "error":
                        raise RuntimeError(f"service error: {message}")

            receiver = asyncio.create_task(receive())
            interval = FRAME_MS / 1_000 / self.speed
            next_send = time.monotonic()
            for chunk in frames:
                await socket.send(chunk)
                next_send += interval
                await asyncio.sleep(max(0.0, next_send - time.monotonic()))
            await socket.send(json.dumps({"type": "stop"}))
            await asyncio.wait_for(receiver, timeout=60)
        return finals


async def _expect(socket: Any, kind: str) -> None:
    while True:
        message = json.loads(await asyncio.wait_for(socket.recv(), timeout=30))
        if message.get("type") == kind:
            return


def _health(port: int) -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as reply:
            payload = json.loads(reply.read())
            return payload if isinstance(payload, dict) else None
    except OSError:
        return None


def start_service(port: int, log: Path) -> tuple[subprocess.Popen[bytes], dict[str, Any]]:
    """Starts the service exactly as `npm run dev` does, minus the reloader.

    Its log goes to a file: an unread pipe fills after 64 KB of access lines and
    then blocks the service mid-run.
    """
    environment = {key: value for key, value in os.environ.items() if not key.startswith("ASR_")}
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("wb") as sink:
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "server.app:app", "--port", str(port)],
            cwd=ROOT,
            env=environment,
            stdout=sink,
            stderr=subprocess.STDOUT,
        )
    deadline = time.monotonic() + READY_TIMEOUT_S
    while time.monotonic() < deadline:
        if process.poll() is not None:
            error = log.read_text(encoding="utf-8", errors="replace")
            raise RuntimeError(f"service exited during startup:\n{error[-2000:]}")
        health = _health(port)
        if health is not None and health.get("status") in {"ready", "error"}:
            return process, health
        time.sleep(1)
    process.terminate()
    raise RuntimeError(f"service was not ready within {READY_TIMEOUT_S} s")


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)] if ordered else 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio-root", type=Path, default=REPLAY_ROOT)
    parser.add_argument("--speed", type=float, default=2.0, help="multiple of real time")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument(
        "--out", type=Path, default=Path("evaluation/results/live/transcripts.json")
    )
    parser.add_argument("--gate", action="store_true")
    arguments = parser.parse_args()

    manifest = load_manifest(MANIFEST)
    inventory = discover_audio(manifest, arguments.audio_root)
    process, health = start_service(arguments.port, arguments.out.with_name("service.log"))
    try:
        model, device = str(health.get("model")), str(health.get("device"))
        print(f"service: {model} on {device} ({health.get('computeType')}), {health.get('status')}")
        if health.get("status") != "ready":
            print(f"FAIL service is not ready: {health.get('error')}")
            return 1
        stats = LiveStats()
        live = LiveServiceModel(f"ws://127.0.0.1:{arguments.port}/ws/asr", arguments.speed, stats)
        config = RuntimeConfig(
            model, device, str(health.get("computeType")), 5, "prompt", "en", Path("models")
        )
        payload = evaluate_configuration(
            manifest,
            MANIFEST,
            arguments.audio_root,
            inventory,
            config,
            allow_missing=not arguments.gate,
            model_factory=lambda _config: live,
        )
    finally:
        process.terminate()
        process.wait(timeout=30)

    results = payload["results"]
    assert isinstance(results, list) and len(results) == len(stats.finals)
    for result, texts in zip(results, stats.finals, strict=True):
        # Scored as the pipeline receives them: one utterance per final.
        if len(texts) > 1:
            result["finals"] = texts
    arguments.out.parent.mkdir(parents=True, exist_ok=True)
    arguments.out.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    chart, passed, cases, false, nonchart = chart_score(arguments.out)
    p50 = statistics.median(stats.latencies_ms) if stats.latencies_ms else 0.0
    p95 = percentile(stats.latencies_ms, 0.95)
    print(
        f"live: {len(results)} recordings at {arguments.speed:g}x real time; chart {chart:.1%} "
        f"({passed}/{cases}), false {false}/{nonchart}, split {len(stats.split)}"
    )
    print(
        f"endpoint -> final: p50 {p50:.0f} ms, p95 {p95:.0f} ms; decode p50 "
        f"{statistics.median(stats.decode_ms) if stats.decode_ms else 0:.0f} ms; partials "
        f"{stats.partials}, dropped {stats.dropped_partials}"
    )
    for text in stats.split:
        print(f"  split: {text}")
    if not arguments.gate:
        return 0

    failures: list[str] = []
    if model != EXPECTED_MODEL or device != EXPECTED_DEVICE:
        failures.append(
            f"service runs {model} on {device}, not {EXPECTED_MODEL} on {EXPECTED_DEVICE}"
        )
    if chart < GATE_MIN_CHART:
        failures.append(f"chart exact {chart:.1%} below {GATE_MIN_CHART:.0%}")
    if false > GATE_MAX_FALSE:
        failures.append(f"{false} false chart entries, at most {GATE_MAX_FALSE} allowed")
    if len(stats.split) > GATE_MAX_SPLIT:
        failures.append(f"{len(stats.split)} recordings split into several finals")
    if p95 > GATE_MAX_P95_MS:
        failures.append(f"endpoint-to-final p95 {p95:.0f} ms above {GATE_MAX_P95_MS} ms")
    for failure in failures:
        print(f"FAIL {failure}")
    if failures:
        return 1
    print(f"LIVE RECOGNIZER PASS {model} on {device}: chart {chart:.1%}, p95 {p95:.0f} ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
