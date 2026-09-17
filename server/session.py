from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Awaitable, Callable
from typing import Any

from server.audio import DecodeKind, DecodeRequest, SpeechSegmenter, SpeechStarted
from server.config import Settings
from server.recognizer import Recognizer

SendMessage = Callable[[dict[str, Any]], Awaitable[None]]


def monotonic_ms() -> float:
    return time.monotonic() * 1_000


class AsrSession:
    """One browser stream with bounded, latest-partial-wins decoding."""

    def __init__(self, recognizer: Recognizer, settings: Settings, send: SendMessage) -> None:
        self.recognizer = recognizer
        self.settings = settings
        self.send = send
        self.segmenter = SpeechSegmenter(settings)
        self._queue: asyncio.Queue[DecodeRequest | None] = asyncio.Queue(
            maxsize=settings.decode_queue_size
        )
        self._worker: asyncio.Task[None] | None = None
        self._closed = False
        self._dropped_partials = 0

    async def start(self) -> None:
        if self._worker is None:
            self._worker = asyncio.create_task(self._decode_loop(), name="asr-session-decode")

    async def feed(self, payload: bytes, received_at_ms: float | None = None) -> None:
        if self._closed:
            raise RuntimeError("Cannot feed a closed ASR session.")
        timestamp = received_at_ms if received_at_ms is not None else monotonic_ms()
        for event in self.segmenter.feed(payload, timestamp):
            if isinstance(event, SpeechStarted):
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
        if request.kind is DecodeKind.PARTIAL:
            self._discard_pending_partials()
            if self._queue.full():
                self._dropped_partials += 1
                return
            self._queue.put_nowait(request)
            return

        self._discard_pending_partials()
        await self._queue.put(request)

    def _discard_pending_partials(self) -> None:
        retained: list[DecodeRequest | None] = []
        while True:
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if isinstance(item, DecodeRequest) and item.kind is DecodeKind.PARTIAL:
                self._dropped_partials += 1
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
                result = await self.recognizer.transcribe(
                    request.audio, partial=request.kind is DecodeKind.PARTIAL
                )
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
                if request.kind is DecodeKind.FINAL:
                    message["words"] = [
                        {
                            "word": word.word,
                            "startMs": word.start_ms,
                            "endMs": word.end_ms,
                            "probability": word.probability,
                        }
                        for word in result.words
                    ]
                await self.send(message)
            except Exception as exc:
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

    async def __aenter__(self) -> AsrSession:
        await self.start()
        return self

    async def __aexit__(self, *_: object) -> None:
        with contextlib.suppress(Exception):
            await self.close()
