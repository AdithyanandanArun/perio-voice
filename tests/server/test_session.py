from __future__ import annotations

import asyncio
from array import array
from typing import Any, cast

import numpy as np
import pytest

from server.audio import DecodeKind, DecodeRequest
from server.config import Settings
from server.recognizer import ModelStatus, RecognitionResult, WordTiming
from server.routed_recognizer import RoutedRecognizer
from server.routing import Engine
from server.session import AsrSession
from tests.server.fakes import FakeRecognizer


def pcm_frame(level: float, milliseconds: int = 100) -> bytes:
    return np.full(16 * milliseconds, round(level * 32_767), dtype="<i2").tobytes()


def pcm_level(level: int, milliseconds: int) -> bytes:
    """Deterministic mono PCM16 at fixed sample-count granularity.

    Used where a test needs a precise millisecond boundary (the 120-200 ms
    semantic hangover band) rather than ``pcm_frame``'s float amplitude.
    """
    return array("h", [level] * (16 * milliseconds)).tobytes()


class _HintGrammarSession:
    """A grammar session double whose result always reports semantic completion."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.closed = False
        self.semantic_complete = False

    async def feed_pcm(self, _payload: bytes) -> RecognitionResult:
        self.semantic_complete = True
        return RecognitionResult(
            text=self.text,
            decode_ms=1,
            engine="grammar",
            words=(WordTiming("three", 0, 100, 0.9),),
        )

    def close(self) -> None:
        self.closed = True


class _HintGrammarRecognizer:
    model_name = "vosk-test"
    device = "cpu"
    compute_type = "grammar"
    status = ModelStatus.READY
    error: str | None = None

    def __init__(self, text: str) -> None:
        self.text = text
        self.sessions: list[_HintGrammarSession] = []

    async def load(self) -> None:
        self.status = ModelStatus.READY

    def set_expectation(self, _expectation: object) -> None:
        return

    async def open_session(self, _expectation: object = None) -> _HintGrammarSession:
        session = _HintGrammarSession(self.text)
        self.sessions.append(session)
        return session


class _TerminalWhisper:
    model_name = "large-v3"
    device = "cuda"
    compute_type = "int8_float16"
    status = ModelStatus.READY
    error: str | None = None

    def __init__(self) -> None:
        self.calls: list[bool] = []

    async def load(self) -> None:
        self.status = ModelStatus.READY

    async def transcribe(
        self,
        _audio: Any,
        *,
        partial: bool,
        beam_size: int | None = None,
    ) -> RecognitionResult:
        del beam_size
        self.calls.append(partial)
        return RecognitionResult(
            text="TERMINAL" if not partial else "PARTIAL",
            decode_ms=7,
            engine="whisper",
        )


class _RaisingRecognizer(FakeRecognizer):
    """A terminal recognizer that raises on the final decode only.

    Partials must keep working so the failure is isolated to the terminal
    path this test cares about (F6: a raising final decode must not leak
    utterance state).
    """

    async def transcribe(self, audio: Any, *, partial: bool) -> RecognitionResult:
        if not partial:
            raise RuntimeError("terminal decode exploded")
        return await super().transcribe(audio, partial=partial)


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


@pytest.mark.asyncio
async def test_identity_endpoint_and_terminal_path_are_ordered() -> None:
    recognizer = FakeRecognizer()
    await recognizer.load()
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=50,
        end_silence_ms=200,
        partial_interval_ms=100,
    )
    session = AsrSession(
        recognizer,
        settings,
        send,
        stream_id="stream-test",
        original_context_version=4,
    )
    await session.start()
    await session.feed(pcm_frame(0.2), 100)
    await session.feed(pcm_frame(0.2), 200)
    await asyncio.sleep(0)
    await session.feed(pcm_frame(0), 300)
    await session.feed(pcm_frame(0), 400)
    await session.stop(500)
    await session.close()

    utterance_messages = [
        message
        for message in messages
        if message["type"] in {"speech_start", "partial", "endpoint", "final"}
    ]
    assert [message["type"] for message in utterance_messages] == [
        "speech_start",
        "partial",
        "endpoint",
        "final",
    ]
    assert [message["revision"] for message in utterance_messages] == [1, 2, 3, 4]
    assert all(message["streamId"] == "stream-test" for message in utterance_messages)
    assert all(message["transactionId"] == "stream-test:1" for message in utterance_messages)
    assert all(message["originalContextVersion"] == 4 for message in utterance_messages)
    assert utterance_messages[0]["lifecycle"] == "provisional"
    assert utterance_messages[-1]["lifecycle"] == "confirmed"
    assert utterance_messages[-1]["recognitionPath"] == "terminal"
    assert utterance_messages[2]["type"] == "endpoint"
    assert utterance_messages[2]["endSample"] == utterance_messages[3]["endSample"]


@pytest.mark.asyncio
async def test_audio_gap_invalidates_active_utterance_and_does_not_chart_it() -> None:
    recognizer = FakeRecognizer(delay=0.02)
    await recognizer.load()
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=50,
        end_silence_ms=200,
        partial_interval_ms=100,
    )
    session = AsrSession(recognizer, settings, send, stream_id="stream-gap")
    await session.start()
    for index in range(3):
        await session.feed(pcm_frame(0.2), (index + 1) * 100)

    acknowledgement = await session.handle_audio_gap(
        stream_id="stream-gap",
        sample_rate=16_000,
        start_sample=4_800,
        end_sample=6_400,
    )
    assert acknowledgement["type"] == "audio_gap_ack"
    await session.feed(pcm_frame(0.2), 500)
    await session.feed(pcm_frame(0.2), 600)
    await session.feed(pcm_frame(0.2), 700)
    await session.stop(900)
    await session.close()

    finals = [message for message in messages if message["type"] == "final"]
    assert len(finals) == 1
    assert finals[0]["utteranceId"] == 2
    assert all(
        not (message["type"] == "final" and message["utteranceId"] == 1) for message in messages
    )
    assert session.telemetry.snapshot()["counters"]["audio_gaps"] == 1  # type: ignore[index]


@pytest.mark.asyncio
async def test_semantic_endpoint_reason_and_last_voice_sample_in_range() -> None:
    """A grammar semantic hint shortens the hangover and is attributed as such."""
    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=40,
        end_silence_ms=520,
        partial_interval_ms=40,
        engine=Engine.AUTO,
        model_name="large-v3",
        device="cuda",
        compute_type="int8_float16",
        speech_presence_threshold=0.0,
    )
    terminal = _TerminalWhisper()
    grammar = _HintGrammarRecognizer("three")
    recognizer = RoutedRecognizer(settings, whisper=terminal, grammar=cast(Any, grammar))
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    session = AsrSession(recognizer, settings, send, stream_id="semantic-test")
    await session.start()
    for index in range(3):
        await session.feed(pcm_level(10_000, 40), (index + 1) * 40)
    # Four 40 ms silence frames reach the 160 ms semantic hangover rather than
    # the ordinary 520 ms budget, because the grammar hint above latched it.
    for index in range(4):
        await session.feed(pcm_level(0, 40), 160 + index * 40)
    await session.stop(360)
    await session.close()

    endpoint = next(message for message in messages if message["type"] == "endpoint")
    final = next(message for message in messages if message["type"] == "final")
    assert endpoint["endpointReason"] == "semantic"
    assert final["endpointReason"] == "semantic"
    for message in (endpoint, final):
        assert message["startSample"] <= message["lastVoiceSample"] <= message["endSample"]
    hangover_ms = (final["endSample"] - final["lastVoiceSample"]) / 16
    assert 120 <= hangover_ms <= 200


@pytest.mark.asyncio
async def test_silence_endpoint_reason_and_last_voice_sample_in_range() -> None:
    """An ordinary trailing-silence endpoint is reported as "silence"."""
    recognizer = FakeRecognizer()
    await recognizer.load()
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=50,
        end_silence_ms=200,
        partial_interval_ms=100,
    )
    session = AsrSession(recognizer, settings, send)
    await session.start()
    await session.feed(pcm_frame(0.2), 100)
    await session.feed(pcm_frame(0.2), 200)
    await session.feed(pcm_frame(0), 300)
    await session.feed(pcm_frame(0), 400)
    await session.stop(500)
    await session.close()

    endpoint = next(message for message in messages if message["type"] == "endpoint")
    final = next(message for message in messages if message["type"] == "final")
    assert endpoint["endpointReason"] == "silence"
    assert final["endpointReason"] == "silence"
    for message in (endpoint, final):
        assert message["startSample"] <= message["lastVoiceSample"] <= message["endSample"]


@pytest.mark.asyncio
async def test_max_length_endpoint_reason_and_last_voice_sample_in_range() -> None:
    """``max_utterance_ms`` cuts a still-voiced utterance and says so."""
    recognizer = FakeRecognizer()
    await recognizer.load()
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=50,
        end_silence_ms=500,
        partial_interval_ms=10_000,
        max_utterance_ms=200,
    )
    session = AsrSession(recognizer, settings, send)
    await session.start()
    await session.feed(pcm_frame(0.1), 100)
    await session.feed(pcm_frame(0.1), 200)
    await session.stop(300)
    await session.close()

    endpoint = next(message for message in messages if message["type"] == "endpoint")
    final = next(message for message in messages if message["type"] == "final")
    assert endpoint["endpointReason"] == "max_length"
    assert final["endpointReason"] == "max_length"
    for message in (endpoint, final):
        assert message["startSample"] <= message["lastVoiceSample"] <= message["endSample"]


@pytest.mark.asyncio
async def test_stop_flush_endpoint_reason_and_last_voice_sample_for_legacy_client() -> None:
    """A client stop() mid-utterance is "stop", including for a legacy client
    that never supplied a streamId."""
    recognizer = FakeRecognizer()
    await recognizer.load()
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=50,
        end_silence_ms=1_000,
        partial_interval_ms=10_000,
    )
    session = AsrSession(recognizer, settings, send)  # no stream_id: legacy client
    await session.start()
    await session.feed(pcm_frame(0.2), 100)
    await session.stop(150)
    await session.close()

    endpoint = next(message for message in messages if message["type"] == "endpoint")
    final = next(message for message in messages if message["type"] == "final")
    assert endpoint["endpointReason"] == "stop"
    assert final["endpointReason"] == "stop"
    assert endpoint["streamId"] is None and final["streamId"] is None
    assert endpoint["transactionId"].startswith("legacy:")
    for message in (endpoint, final):
        assert message["startSample"] <= message["lastVoiceSample"] <= message["endSample"]


@pytest.mark.asyncio
async def test_decode_failure_frees_utterance_state() -> None:
    """A raising terminal decode still emits an error and frees its state (F6)."""
    recognizer = _RaisingRecognizer()
    await recognizer.load()
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=50,
        end_silence_ms=200,
        partial_interval_ms=100,
    )
    session = AsrSession(recognizer, settings, send)
    await session.start()
    await session.feed(pcm_frame(0.2), 100)
    await session.feed(pcm_frame(0.2), 200)
    await session.feed(pcm_frame(0), 300)
    await session.feed(pcm_frame(0), 400)
    await session.stop(500)
    await session.close()

    errors = [message for message in messages if message["type"] == "error"]
    assert errors and errors[0]["code"] == "decode_failed"
    assert not any(message["type"] == "final" for message in messages)
    assert session._utterances == {}
