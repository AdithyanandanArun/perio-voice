from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any

from server.audio import DecodeKind, DecodeRequest, SpeechSegmenter, SpeechStarted
from server.cadence import CadenceController
from server.config import Settings
from server.denoise import apply_profile
from server.recognizer import Recognizer
from server.speaker import SpeakerGate
from server.telemetry import Telemetry

SendMessage = Callable[[dict[str, Any]], Awaitable[None]]


def monotonic_ms() -> float:
    return time.monotonic() * 1_000


class AsrSession:
    """One browser stream with bounded, latest-partial-wins decoding.

    The session owns everything that has to happen per utterance and in order:
    endpointing, backpressure, preprocessing, recognition, speaker attribution
    and the cadence feedback that moves the endpoint for the next utterance.
    """

    def __init__(
        self,
        recognizer: Recognizer,
        settings: Settings,
        send: SendMessage,
        *,
        telemetry: Telemetry | None = None,
        speaker_gate: SpeakerGate | None = None,
    ) -> None:
        self.recognizer = recognizer
        self.settings = settings
        self.send = send
        self.segmenter = SpeechSegmenter(settings)
        self.cadence = CadenceController(settings)
        self.telemetry = telemetry or Telemetry()
        self.speaker_gate = speaker_gate
        self._queue: asyncio.Queue[DecodeRequest | None] = asyncio.Queue(
            maxsize=settings.decode_queue_size
        )
        self._worker: asyncio.Task[None] | None = None
        self._closed = False
        self._dropped_partials = 0

    async def start(self) -> None:
        if self._worker is None:
            self.telemetry.count("streams_started")
            self._worker = asyncio.create_task(self._decode_loop(), name="asr-session-decode")

    async def feed(self, payload: bytes, received_at_ms: float | None = None) -> None:
        if self._closed:
            raise RuntimeError("Cannot feed a closed ASR session.")
        timestamp = received_at_ms if received_at_ms is not None else monotonic_ms()
        for event in self.segmenter.feed(payload, timestamp):
            if isinstance(event, SpeechStarted):
                self.telemetry.count("utterances_total")
                await self.send(
                    {
                        "type": "speech_start",
                        "utteranceId": event.utterance_id,
                        "startedAtMs": round(event.started_at_ms, 2),
                    }
                )
            else:
                await self._enqueue(event)

    async def stop(self, received_at_ms: float | None = None) -> None:
        if self._closed:
            return
        timestamp = received_at_ms if received_at_ms is not None else monotonic_ms()
        final = self.segmenter.flush(timestamp)
        if final is not None:
            await self._enqueue(final)
        await self._queue.join()
        await self.send({"type": "stopped", "droppedPartials": self._dropped_partials})

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._discard_pending_partials()
        if self._worker is not None:
            await self._queue.put(None)
            await self._worker
            self._worker = None

    async def _enqueue(self, request: DecodeRequest) -> None:
        stamped = replace(request, queued_at_ms=monotonic_ms())
        if stamped.kind is DecodeKind.PARTIAL:
            self._discard_pending_partials()
            if self._queue.full():
                self._dropped_partials += 1
                self.telemetry.count("partials_dropped")
                return
            self._queue.put_nowait(stamped)
            return

        self._discard_pending_partials()
        await self._queue.put(stamped)

    def _discard_pending_partials(self) -> None:
        retained: list[DecodeRequest | None] = []
        while True:
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if isinstance(item, DecodeRequest) and item.kind is DecodeKind.PARTIAL:
                self._dropped_partials += 1
                self.telemetry.count("partials_dropped")
                self._queue.task_done()
            else:
                retained.append(item)
        for item in retained:
            self._queue.put_nowait(item)

    async def _decode_loop(self) -> None:
        while True:
            request = await self._queue.get()
            try:
                if request is None:
                    return
                await self._decode(request)
            except Exception as exc:
                self.telemetry.count("decode_errors")
                await self.send(
                    {
                        "type": "error",
                        "code": "decode_failed",
                        "recoverable": True,
                        "message": f"Recognition failed: {exc}",
                    }
                )
            finally:
                self._queue.task_done()

    async def _decode(self, request: DecodeRequest) -> None:
        final = request.kind is DecodeKind.FINAL
        if request.queued_at_ms:
            self.telemetry.observe("queue_wait_ms", max(0.0, monotonic_ms() - request.queued_at_ms))

        audio = apply_profile(request.audio, request.sample_rate, self.settings.denoise_profile)
        result = await self.recognizer.transcribe(audio, partial=not final)

        self.telemetry.count("finals_total" if final else "partials_total")
        self.telemetry.observe(
            "decode_ms_final" if final else "decode_ms_partial", result.decode_ms
        )
        self.telemetry.observe("audio_ms", request.audio_ms)

        message: dict[str, Any] = {
            "type": request.kind.value,
            "utteranceId": request.utterance_id,
            "text": result.text,
            "audioMs": request.audio_ms,
            "decodeMs": result.decode_ms,
            "startedAtMs": round(request.started_at_ms, 2),
            "endedAtMs": round(request.ended_at_ms, 2),
            "droppedPartials": self._dropped_partials,
        }

        if final:
            message["words"] = [
                {
                    "word": word.word,
                    "startMs": word.start_ms,
                    "endMs": word.end_ms,
                    "probability": word.probability,
                }
                for word in result.words
            ]
            message["speaker"] = self._attribute(request)
            message["cadence"] = self._adapt(result.words, request.audio_ms)
        await self.send(message)

    def _attribute(self, request: DecodeRequest) -> dict[str, object] | None:
        """Speaker attribution runs on the raw utterance, before preprocessing."""
        if self.speaker_gate is None:
            return None
        verdict = self.speaker_gate.verify(request.audio)
        self.telemetry.count(f"speaker_{verdict.decision.value}")
        return verdict.as_message()

    def _adapt(self, words: Any, audio_ms: int) -> dict[str, object]:
        state = self.cadence.observe(words, audio_ms)
        self.segmenter.end_silence_ms = state.end_silence_ms
        self.telemetry.observe("end_silence_ms", state.end_silence_ms)
        self.telemetry.observe("speech_ms", audio_ms)
        return state.as_message()

    async def __aenter__(self) -> AsrSession:
        await self.start()
        return self

    async def __aexit__(self, *_: object) -> None:
        with contextlib.suppress(Exception):
            await self.close()
