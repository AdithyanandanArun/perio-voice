from __future__ import annotations

import asyncio
from typing import Any

import numpy as np
import pytest

from server.audio import DecodeKind, DecodeRequest
from server.config import Settings
from server.session import AsrSession
from tests.server.fakes import FakeRecognizer


def pcm_frame(level: float, milliseconds: int = 100) -> bytes:
    return np.full(16 * milliseconds, round(level * 32_767), dtype="<i2").tobytes()


@pytest.mark.asyncio
async def test_session_sends_partial_final_metrics_and_stop() -> None:
    recognizer = FakeRecognizer()
    await recognizer.load()
    messages: list[dict[str, Any]] = []
    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=50,
        end_silence_ms=200,
        partial_interval_ms=100,
    )

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    session = AsrSession(recognizer, settings, send)
    await session.start()
    await session.feed(pcm_frame(0.2), 100)
    await session.feed(pcm_frame(0.2), 200)
    await asyncio.sleep(0)
    await session.feed(pcm_frame(0), 300)
    await session.feed(pcm_frame(0), 400)
    await session.stop(500)
    await session.close()

    types = [message["type"] for message in messages]
    assert types[0] == "speech_start"
    assert "partial" in types
    assert "final" in types
    assert types[-1] == "stopped"
    final = next(message for message in messages if message["type"] == "final")
    assert final["text"] == "three four five"
    assert final["decodeMs"] == 4
    assert final["words"][0]["word"] == "three"


@pytest.mark.asyncio
async def test_latest_partial_wins_when_decode_queue_is_busy() -> None:
    recognizer = FakeRecognizer(delay=0.03)
    await recognizer.load()
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    settings = Settings(decode_queue_size=1)
    session = AsrSession(recognizer, settings, send)
    await session.start()
    audio = np.ones(1_600, dtype=np.float32)
    for utterance_id in range(1, 6):
        await session._enqueue(DecodeRequest(utterance_id, DecodeKind.PARTIAL, audio, 0, 100))
    await session._enqueue(DecodeRequest(6, DecodeKind.FINAL, audio, 0, 100))
    await session.stop(200)
    await session.close()

    finals = [message for message in messages if message["type"] == "final"]
    stopped = next(message for message in messages if message["type"] == "stopped")
    assert len(finals) == 1
    assert finals[0]["utteranceId"] == 6
    assert stopped["droppedPartials"] >= 4
