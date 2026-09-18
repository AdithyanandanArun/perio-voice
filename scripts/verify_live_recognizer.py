"""Streams the replay recordings through the running service, as the browser does.

The bake-off decodes each recording whole. The live service never sees a whole
recording: the browser streams 40 ms PCM frames (the evaluator keeps 100 ms
fixture frames for compatibility), the energy endpointer decides
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

Latency is measured from the endpoint event arriving at the client to the final
arriving at the client, which is queue wait behind a partial plus decode plus
transport. The endpoint's captured sample offsets separately measure semantic
hangover; the two client arrivals use one CLOCK_MONOTONIC clock.

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
from typing import Any, cast

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

# This module's own ``--gate`` is the committed oracle for project gate G44
# (see GATES.md): >=90% chart exact match, <=2 false entries, <=3 split
# recordings, endpoint -> final p95 <=700 ms, on large-v3/cuda. That is the
# ONLY contract this file's --gate enforces. The strict, narrower replay
# contract (98/104 chart cases, 450 ms endpoint p95, semantic-only 200/650 ms
# hangover/composed budgets, 80% semantic coverage of chartable finals) lives
# entirely in ``verify_latency_quality.py --gate``, which runs this evaluator
# and independently recomputes its own thresholds from the liveTiming
# evidence this module always writes. Do not add the strict numbers back
# here: one command must mean one claim.
GATE_MIN_CHART = 0.90
GATE_MAX_FALSE = 2
GATE_MAX_SPLIT = 3
GATE_MAX_ENDPOINT_TO_FINAL_P95_MS = 700
# Import-compatible aliases for callers of the former (strict) evaluator
# contract. These are not used by this module's own --gate.
GATE_MAX_P95_MS = GATE_MAX_ENDPOINT_TO_FINAL_P95_MS
GATE_MIN_CHART_CASES = 98
GATE_MIN_CHART_TOTAL = 104
GATE_MAX_SEMANTIC_HANGOVER_MS = 200
GATE_MAX_LAST_VOICE_TO_FINAL_P95_MS = 650


class LiveStats:
    def __init__(self) -> None:
        # ``latencies_ms`` is retained for ordinary report consumers. New code
        # should use the explicit endpoint-to-final series below.
        self.latencies_ms: list[float] = []
        # All text finals, regardless of endpointReason. G44's 700 ms budget
        # and the strict 450 ms budget both apply to this unfiltered series.
        self.endpoint_to_final_ms: list[float] = []
        # The semantic hangover and composed last-voice->final controls apply
        # only to finals whose endpointReason is "semantic" (F3): a
        # conversational utterance the grammar cannot semantically complete
        # correctly ends on the ordinary silence window instead, and that is
        # a correct outcome, not a latency defect.
        self.semantic_hangover_ms: list[float] = []
        self.last_voice_to_final_ms: list[float] = []
        # Parallel to the two arrays above (same order, same filter to
        # endpointReason == "semantic"): the endpoint-to-final component of
        # each composed sample, so an independent consumer can verify
        # last_voice_to_final_ms[i] == semantic_endpoint_to_final_ms[i] +
        # semantic_hangover_ms[i] without assuming alignment with the
        # unfiltered endpoint_to_final_ms series above.
        self.semantic_endpoint_to_final_ms: list[float] = []
        # Reported (p50/p95 in the printed summary) but never gated: the
        # composed latency of finals that ended on the silence window.
        self.silence_last_voice_to_final_ms: list[float] = []
        self.decode_ms: list[int] = []
        self.split: list[str] = []
        self.finals: list[list[str]] = []
        """The non-empty finals of each recording, in decode order."""
        # One entry per non-empty text final, in arrival order, independent of
        # the per-recording ``finals`` grouping above. ``recordingIndex`` is
        # filled in as fast as recordings are streamed and is later matched
        # against ``results[i]["chartable"]`` once the clinical scorer has
        # run, so the strict gate can require semantic-reason coverage over
        # chartable finals specifically (F3), not over every recording.
        self.final_records: list[dict[str, Any]] = []
        self.partials = 0
        self.dropped_partials = 0
        self.endpoint_messages = 0
        self.timed_endpoint_messages = 0
        self.matched_endpoint_finals = 0
        self.timed_finals = 0
        self.text_finals = 0
        self.legacy_latency_finals = 0
        self.timing_conflicts = 0


def _number(value: object) -> float | None:
    """Return a finite number, excluding booleans masquerading as integers."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _non_negative(value: object) -> float | None:
    result = _number(value)
    return result if result is not None and result >= 0 else None


def _field(message: dict[str, Any], *names: str) -> object | None:
    """Read flat or nested additive protocol fields.

    The shipped protocol uses camelCase flat fields. Accepting snake_case and a
    nested ``timing`` object keeps this evaluator useful against older replay
    servers and captures without making the strict gate depend on one spelling.
    """
    timing = message.get("timing")
    nested: dict[str, Any] = timing if isinstance(timing, dict) else {}
    for name in names:
        if name in message:
            return cast(object, message[name])
        if name in nested:
            return cast(object, nested[name])
    return None


def sample_timing(message: dict[str, Any]) -> dict[str, float | int | bool | None]:
    """Normalize additive endpoint/sample fields without inventing evidence.

    ``startSample``/``endSample`` are absolute stream offsets. The corresponding
    ``*OffsetSamples`` forms are relative to ``startSample`` and are accepted for
    server implementations that keep utterance-local offsets. A direct
    ``hangoverMs`` is reportable for diagnostics, but it is *not* strict sample
    evidence unless both last-voice and endpoint samples are present.
    """
    sample_rate_value = _non_negative(_field(message, "sampleRate", "sample_rate"))
    sample_rate = int(sample_rate_value) if sample_rate_value and sample_rate_value > 0 else None
    start = _non_negative(_field(message, "startSample", "start_sample"))
    end = _non_negative(
        _field(
            message,
            "endSample",
            "end_sample",
            "endpointSample",
            "endpoint_sample",
        )
    )
    duration = _non_negative(_field(message, "durationSamples", "duration_samples"))
    last = _non_negative(
        _field(
            message,
            "lastVoiceSample",
            "lastVoicedSample",
            "last_voice_sample",
            "last_voiced_sample",
        )
    )
    last_offset = _non_negative(
        _field(
            message,
            "lastVoiceOffsetSamples",
            "lastVoicedOffsetSamples",
            "last_voice_offset_samples",
        )
    )
    endpoint_offset = _non_negative(
        _field(message, "endpointOffsetSamples", "endpoint_offset_samples")
    )

    if start is not None and last is None and last_offset is not None:
        last = start + last_offset
    if start is not None and end is None and endpoint_offset is not None:
        end = start + endpoint_offset
    if start is not None and end is None and duration is not None:
        end = start + duration
    if start is not None and duration is None and end is not None and end >= start:
        duration = end - start

    # The protocol's sample offsets imply the required sample rate when an old
    # server omitted the additive field. This is still explicit sample evidence,
    # unlike deriving timing from a wall-clock endedAtMs.
    if sample_rate is None and (start is not None or end is not None or last is not None):
        sample_rate = SAMPLE_RATE

    hangover_ms: float | None = None
    if sample_rate and end is not None and last is not None and end >= last:
        hangover_ms = (end - last) * 1_000 / sample_rate

    direct_hangover = _non_negative(
        _field(message, "semanticHangoverMs", "endpointHangoverMs", "hangoverMs", "hangover_ms")
    )
    return {
        "sampleRate": sample_rate,
        "startSample": int(start) if start is not None else None,
        "endSample": int(end) if end is not None else None,
        "lastVoiceSample": int(last) if last is not None else None,
        "durationSamples": int(duration) if duration is not None else None,
        "hangoverMs": hangover_ms if hangover_ms is not None else direct_hangover,
        "sampleEvidence": bool(
            sample_rate and end is not None and last is not None and end >= last
        ),
    }


VALID_ENDPOINT_REASONS = frozenset({"semantic", "silence", "max_length", "stop"})


def endpoint_reason(*messages: dict[str, Any] | None) -> str | None:
    """Read ``endpointReason`` from the first message that carries a valid one.

    A final and its endpoint are required to agree; checking both tolerates a
    server that stamps the reason on only one of the two events without
    accepting an unrecognised value as evidence.
    """
    for message in messages:
        if message is None:
            continue
        value = message.get("endpointReason")
        if isinstance(value, str) and value in VALID_ENDPOINT_REASONS:
            return value
    return None


def message_key(message: dict[str, Any]) -> str | None:
    for name in ("utteranceId", "utterance_id", "transactionId", "transaction_id"):
        value = message.get(name)
        if value is not None and str(value).strip():
            return str(value)
    return None


def _take_endpoint(pending: list[dict[str, Any]], final: dict[str, Any]) -> dict[str, Any] | None:
    """Pop the endpoint belonging to ``final`` without reusing an event."""
    if not pending:
        return None
    key = message_key(final)
    if key is not None:
        for index, candidate in enumerate(pending):
            if candidate.get("key") == key:
                return pending.pop(index)
    # A missing id is a legacy omission, not permission to reorder events.
    return pending.pop(0)


class LiveServiceModel:
    """Looks like a faster-whisper model; each transcribe() is one live stream."""

    def __init__(self, url: str, speed: float, stats: LiveStats) -> None:
        self.url = url
        self.speed = speed
        self.stats = stats

    def transcribe(self, audio: Any, **_options: object) -> tuple[list[Segment], None]:
        # ``recording_index`` is fixed before streaming starts: it is the
        # position this recording will occupy in ``stats.finals``/``results``,
        # since both are appended once per call in manifest order.
        recording_index = len(self.stats.finals)
        finals = asyncio.run(self._stream(np.asarray(audio, dtype=np.float32), recording_index))
        texts = [str(item["text"]).strip() for item in finals if str(item["text"]).strip()]
        self.stats.finals.append(texts)
        if len(texts) > 1:
            self.stats.split.append(" | ".join(texts))
        probability = max((float(item.get("noSpeechProb", 0.0)) for item in finals), default=0.0)
        return [Segment(text=" ".join(texts), no_speech_prob=probability)], None

    async def _stream(self, audio: np.ndarray, recording_index: int) -> list[dict[str, Any]]:
        import websockets

        pcm = (np.clip(audio, -1.0, 1.0) * 32_767).astype("<i2")
        frame = SAMPLE_RATE * FRAME_MS // 1_000
        silence = np.zeros(SAMPLE_RATE * TRAILING_SILENCE_MS // 1_000, dtype="<i2")
        samples = np.concatenate([pcm, silence])
        frames = [samples[i : i + frame].tobytes() for i in range(0, len(samples), frame)]
        finals: list[dict[str, Any]] = []
        # Endpoint messages are additive in protocol v1. Keep them keyed by
        # utterance when available, but retain FIFO matching for an older server
        # that emits the endpoint marker without an utterance id.
        pending_endpoints: list[dict[str, Any]] = []
        async with websockets.connect(self.url, max_size=None) as socket:
            await _expect(socket, "model_ready")
            # Keep the control compatible with pre-v1 servers. Endpoint and
            # final identity is matched by utterance/transaction ids when a
            # newer server supplies them; no optional start field is required
            # for ordinary old-server reporting.
            await socket.send(json.dumps({"type": "start"}))
            await _expect(socket, "listening")

            async def receive() -> None:
                async for raw in socket:
                    arrived = time.monotonic() * 1_000
                    message = json.loads(raw)
                    kind = message.get("type")
                    if kind == "partial":
                        self.stats.partials += 1
                    elif kind in {"endpoint", "speech_end"}:
                        timing = sample_timing(message)
                        self.stats.endpoint_messages += 1
                        if bool(timing["sampleEvidence"]):
                            self.stats.timed_endpoint_messages += 1
                        pending_endpoints.append(
                            {
                                "key": message_key(message),
                                "arrivedMs": arrived,
                                "timing": timing,
                                "message": message,
                            }
                        )
                    elif kind == "final":
                        finals.append(message)
                        text = str(message.get("text", "")).strip()
                        endpoint = _take_endpoint(pending_endpoints, message)
                        final_timing = sample_timing(message)
                        endpoint_message = endpoint["message"] if endpoint is not None else None
                        reason = endpoint_reason(message, endpoint_message)
                        record: dict[str, Any] = {
                            "recordingIndex": recording_index,
                            "reason": reason,
                            "hasReason": reason is not None,
                            "hasLastVoiceSample": bool(final_timing["sampleEvidence"]),
                            "endpointToFinalMs": None,
                            "hangoverMs": None,
                            "lastVoiceToFinalMs": None,
                        }
                        if endpoint is not None:
                            endpoint_timing = endpoint["timing"]
                            endpoint_sample_evidence = bool(endpoint_timing["sampleEvidence"])
                            if endpoint_sample_evidence:
                                record["hasLastVoiceSample"] = True
                            endpoint_hangover = endpoint_timing["hangoverMs"]
                            final_hangover = final_timing["hangoverMs"]
                            if endpoint_hangover is None and final_timing["sampleEvidence"]:
                                endpoint_hangover = final_hangover
                            elif (
                                endpoint_hangover is not None
                                and final_hangover is not None
                                and abs(float(endpoint_hangover) - float(final_hangover)) > 1.0
                            ):
                                self.stats.timing_conflicts += 1
                            if text:
                                self.stats.matched_endpoint_finals += 1
                                endpoint_latency = max(0.0, arrived - float(endpoint["arrivedMs"]))
                                self.stats.endpoint_to_final_ms.append(endpoint_latency)
                                self.stats.latencies_ms.append(endpoint_latency)
                                record["endpointToFinalMs"] = endpoint_latency
                                # A direct ``hangoverMs`` is useful in the
                                # ordinary report, but strict evidence must be
                                # tied to captured sample offsets on the
                                # endpoint event itself. This keeps a claimed
                                # wall-clock duration from satisfying the gate.
                                if endpoint_sample_evidence and endpoint_hangover is not None:
                                    self.stats.timed_finals += 1
                                    composed = endpoint_latency + float(endpoint_hangover)
                                    record["hangoverMs"] = float(endpoint_hangover)
                                    record["lastVoiceToFinalMs"] = composed
                                    # The hangover/composed controls apply only
                                    # to finals the grammar semantically
                                    # completed early (F3): conversational
                                    # speech that instead rides out the
                                    # ordinary silence window is a correct
                                    # outcome, not a slow semantic path, and
                                    # must not be scored against the 200/650 ms
                                    # budgets.
                                    if reason == "semantic":
                                        self.stats.semantic_hangover_ms.append(
                                            float(endpoint_hangover)
                                        )
                                        self.stats.last_voice_to_final_ms.append(composed)
                                        self.stats.semantic_endpoint_to_final_ms.append(
                                            endpoint_latency
                                        )
                                    elif reason == "silence":
                                        self.stats.silence_last_voice_to_final_ms.append(composed)
                        elif text:
                            # Old servers have no endpoint event. Keep ordinary
                            # reporting useful, but --gate will reject this
                            # fallback because it cannot prove the complete path.
                            ended_at = _number(message.get("endedAtMs"))
                            if ended_at is not None:
                                legacy_latency = max(0.0, arrived - ended_at)
                                self.stats.latencies_ms.append(legacy_latency)
                                self.stats.legacy_latency_finals += 1
                        if text:
                            self.stats.text_finals += 1
                            self.stats.final_records.append(record)
                            decode_ms = _number(message.get("decodeMs"))
                            if decode_ms is not None:
                                self.stats.decode_ms.append(max(0, round(decode_ms)))
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


def timing_report(stats: LiveStats, chartable_by_recording: list[bool]) -> dict[str, Any]:
    """Serialize raw timing samples for an independent gate consumer.

    ``chartable_by_recording`` is ``results[i]["chartable"]`` in recording
    order; it is merged in here (after streaming, once the clinical scorer's
    results exist) so the strict semantic-coverage control (F3) can be
    computed over chartable finals specifically, not every recording.
    """

    def chartable(record: dict[str, Any]) -> bool:
        index = record["recordingIndex"]
        return (
            bool(chartable_by_recording[index])
            if 0 <= index < len(chartable_by_recording)
            else False
        )

    finals = [dict(record, chartable=chartable(record)) for record in stats.final_records]
    chartable_finals = [record for record in finals if record["chartable"]]
    semantic_finals = [record for record in finals if record["reason"] == "semantic"]
    semantic_chartable_finals = [
        record for record in chartable_finals if record["reason"] == "semantic"
    ]
    return {
        "schemaVersion": 2,
        "endpointToFinalMs": [round(value, 3) for value in stats.endpoint_to_final_ms],
        "semanticHangoverMs": [round(value, 3) for value in stats.semantic_hangover_ms],
        "lastVoiceToFinalMs": [round(value, 3) for value in stats.last_voice_to_final_ms],
        "semanticEndpointToFinalMs": [
            round(value, 3) for value in stats.semantic_endpoint_to_final_ms
        ],
        "silenceLastVoiceToFinalMs": [
            round(value, 3) for value in stats.silence_last_voice_to_final_ms
        ],
        "textFinals": stats.text_finals,
        "chartableTextFinals": len(chartable_finals),
        "semanticTextFinals": len(semantic_finals),
        "semanticChartableTextFinals": len(semantic_chartable_finals),
        "finalsWithReason": sum(1 for record in finals if record["hasReason"]),
        "finalsWithLastVoiceSample": sum(1 for record in finals if record["hasLastVoiceSample"]),
        "matchedEndpointFinals": stats.matched_endpoint_finals,
        "timedFinals": stats.timed_finals,
        "endpointMessages": stats.endpoint_messages,
        "timedEndpointMessages": stats.timed_endpoint_messages,
        "legacyLatencyFinals": stats.legacy_latency_finals,
        "timingConflicts": stats.timing_conflicts,
        "sampleRate": SAMPLE_RATE,
        "finals": finals,
    }


def _timing_summary(values: list[float]) -> str:
    if not values:
        return "unavailable"
    return (
        f"p50 {statistics.median(values):.0f} ms, "
        f"p95 {percentile(values, 0.95):.0f} ms, max {max(values):.0f} ms"
    )


def g44_contract_failures(
    *,
    model: str,
    device: str,
    chart: float,
    cases: int,
    false_entries: int,
    split_recordings: int,
    endpoint_p95_ms: float,
    has_latency_evidence: bool,
) -> list[str]:
    """Project gate G44 (GATES.md) as a pure function of its raw inputs.

    >=90% chart exact, <=2 false entries, <=3 split recordings, endpoint ->
    final p95 <=700 ms, large-v3 on cuda. This is the ONLY contract this
    module's own ``--gate`` enforces (F8): the narrower strict replay
    contract (98/104 chart cases, 450 ms endpoint p95, semantic-only
    hangover/composed budgets, 80% semantic coverage) lives entirely in
    ``verify_latency_quality.py --gate``. Taking no report/JSON shape as
    input, and loading no model, keeps this importable for a deterministic
    unit check of the G44 decision itself.
    """
    failures: list[str] = []
    if model != EXPECTED_MODEL or device != EXPECTED_DEVICE:
        failures.append(
            f"service runs {model} on {device}, not {EXPECTED_MODEL} on {EXPECTED_DEVICE}"
        )
    if cases <= 0 or chart < GATE_MIN_CHART:
        failures.append(f"chart exact {chart:.1%} below {GATE_MIN_CHART:.0%}")
    if false_entries > GATE_MAX_FALSE:
        failures.append(f"{false_entries} false chart entries, at most {GATE_MAX_FALSE} allowed")
    if split_recordings > GATE_MAX_SPLIT:
        failures.append(f"{split_recordings} recordings split into several finals")
    if not has_latency_evidence:
        failures.append("no endpoint/final latency evidence was measured")
    if endpoint_p95_ms > GATE_MAX_ENDPOINT_TO_FINAL_P95_MS:
        failures.append(
            f"endpoint-to-final p95 {endpoint_p95_ms:.0f} ms above "
            f"{GATE_MAX_ENDPOINT_TO_FINAL_P95_MS} ms"
        )
    return failures


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
    chartable_by_recording = [bool(result.get("chartable", True)) for result in results]
    payload["liveTiming"] = timing_report(stats, chartable_by_recording)
    arguments.out.parent.mkdir(parents=True, exist_ok=True)
    arguments.out.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    chart, passed, cases, false, nonchart = chart_score(arguments.out)
    # New endpoint events are the primary series. The endedAtMs fallback is
    # intentionally retained for ordinary reporting against older servers. If
    # a mixed server emits both forms, retain every ordinary-report sample
    # instead of silently dropping legacy finals from the summary.
    endpoint_values = (
        stats.endpoint_to_final_ms
        if len(stats.endpoint_to_final_ms) == stats.text_finals
        else stats.latencies_ms
    )
    p50 = statistics.median(endpoint_values) if endpoint_values else 0.0
    p95 = percentile(endpoint_values, 0.95)
    timing = payload["liveTiming"]
    assert isinstance(timing, dict)
    chartable_text_finals = int(timing["chartableTextFinals"])
    semantic_chartable_text_finals = int(timing["semanticChartableTextFinals"])
    semantic_coverage = (
        semantic_chartable_text_finals / chartable_text_finals if chartable_text_finals else 0.0
    )
    print(
        f"live: {len(results)} recordings at {arguments.speed:g}x real time; chart {chart:.1%} "
        f"({passed}/{cases}), false {false}/{nonchart}, split {len(stats.split)}"
    )
    print(
        f"endpoint -> final (all text finals): p50 {p50:.0f} ms, p95 {p95:.0f} ms; decode p50 "
        f"{statistics.median(stats.decode_ms) if stats.decode_ms else 0:.0f} ms; partials "
        f"{stats.partials}, dropped {stats.dropped_partials}"
    )
    print(
        "semantic endpoint (hangover/composed budgets apply only here): "
        f"{semantic_chartable_text_finals}/{chartable_text_finals} chartable finals "
        f"({semantic_coverage:.0%}); hangover "
        f"{_timing_summary(stats.semantic_hangover_ms)}; last-voice -> final "
        f"{_timing_summary(stats.last_voice_to_final_ms)}"
    )
    print(
        "silence endpoint (reported, not gated): last-voice -> final "
        f"{_timing_summary(stats.silence_last_voice_to_final_ms)}"
    )
    print(
        "timing evidence: "
        f"{stats.matched_endpoint_finals}/{stats.text_finals} text finals matched to "
        f"{stats.timed_finals} sample-timed endpoint(s); "
        f"{stats.endpoint_messages} endpoint messages, "
        f"{stats.legacy_latency_finals} legacy fallback(s); "
        f"{timing['finalsWithReason']}/{stats.text_finals} carry endpointReason"
    )
    for text in stats.split:
        print(f"  split: {text}")
    if not arguments.gate:
        return 0

    # This --gate enforces exactly project gate G44 (GATES.md): >=90% chart
    # exact, <=2 false entries, <=3 split recordings, endpoint->final p95
    # <=700 ms, large-v3 on cuda. The narrower strict contract (98/104 chart
    # cases, 450 ms endpoint p95, semantic-only hangover/composed budgets,
    # 80% semantic coverage) is enforced only by
    # ``verify_latency_quality.py --gate``, which reads the liveTiming
    # evidence this run always writes to ``arguments.out`` regardless of
    # which gate is invoked.
    failures = g44_contract_failures(
        model=model,
        device=device,
        chart=chart,
        cases=cases,
        false_entries=false,
        split_recordings=len(stats.split),
        endpoint_p95_ms=p95,
        has_latency_evidence=bool(endpoint_values),
    )
    for failure in failures:
        print(f"FAIL {failure}")
    if failures:
        return 1
    print(f"LIVE RECOGNIZER PASS {model} on {device}: chart {chart:.1%}, p95 {p95:.0f} ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
