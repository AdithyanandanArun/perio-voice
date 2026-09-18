"""A prompted recognizer given noise recites its prompt, so noise must not reach it."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest
from faster_whisper.audio import decode_audio

from evaluation.noise import synthesize
from server.config import Settings
from server.session import AsrSession
from server.speech_presence import assess, speech_probability
from tests.server.fakes import FakeRecognizer

JFK = Path("tests/fixtures/jfk.flac")
THRESHOLD = 0.35


def burst(name: str, level: float, seconds: float = 0.6) -> np.ndarray:
    """An operatory noise burst shaped like an endpointed segment."""
    rng = np.random.default_rng(3)
    noise = synthesize(name, int(16_000 * seconds), 16_000, seed=1)
    noise = noise / (np.sqrt(np.mean(noise**2)) or 1.0) * level
    quiet = rng.normal(0, 0.001, 8_000)
    return np.concatenate([quiet, noise, quiet]).astype(np.float32)


def speech() -> np.ndarray:
    return np.asarray(decode_audio(str(JFK), sampling_rate=16_000)[:48_000], dtype=np.float32)


@pytest.mark.parametrize("name", ["suction", "handpiece", "chair", "scaler", "hvac", "babble"])
def test_operatory_noise_scores_below_the_threshold(name: str) -> None:
    for level in (0.02, 0.06, 0.15):
        assert speech_probability(burst(name, level)) < THRESHOLD, (name, level)


def test_speech_scores_above_the_threshold() -> None:
    assert speech_probability(speech()) > 0.8


def test_empty_audio_is_not_speech() -> None:
    assert speech_probability(np.zeros(0, dtype=np.float32)) == 0.0


async def run_session(
    audio: np.ndarray, threshold: float
) -> tuple[FakeRecognizer, list[dict[str, Any]]]:
    recognizer = FakeRecognizer()
    await recognizer.load()
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    settings = Settings(speech_presence_threshold=threshold, partial_interval_ms=10_000)
    session = AsrSession(recognizer, settings, send)
    await session.start()
    pcm = (np.clip(audio, -1, 1) * 32_767).astype("<i2")
    silence = np.zeros(16_000, dtype="<i2")
    stream = np.concatenate([pcm, silence])
    clock = 0.0
    for start in range(0, len(stream), 1_600):
        clock += 100
        await session.feed(stream[start : start + 1_600].tobytes(), clock)
    await session.stop(clock + 100)
    await session.close()
    return recognizer, messages


@pytest.mark.asyncio
async def test_a_noise_burst_never_reaches_the_recognizer() -> None:
    recognizer, messages = await run_session(burst("suction", 0.15), THRESHOLD)
    finals = [message for message in messages if message["type"] == "final"]
    assert finals, "the endpointer should still cut the burst as a segment"
    assert all(final["text"] == "" and final["reason"] == "no_speech" for final in finals)
    assert all(final["speechPresence"] < THRESHOLD for final in finals)
    assert recognizer.calls == []


@pytest.mark.asyncio
async def test_without_the_gate_the_same_burst_is_decoded() -> None:
    """Negative control: the burst above is a segment the recognizer would see."""
    recognizer, messages = await run_session(burst("suction", 0.15), 0.0)
    assert recognizer.calls
    assert any(message["type"] == "final" and message["text"] for message in messages)


@pytest.mark.asyncio
async def test_speech_passes_the_gate_and_reports_its_presence() -> None:
    recognizer, messages = await run_session(speech(), THRESHOLD)
    finals = [message for message in messages if message["type"] == "final" and message["text"]]
    assert finals
    assert all(final["speechPresence"] >= THRESHOLD for final in finals)
    assert any(not partial for _, partial in recognizer.calls)


def test_a_saturated_capture_is_refused_even_if_it_sounds_like_speech() -> None:
    """A broken capture path produced constant full-scale noise that the prompted
    recognizer read as "b o p d three four five." Clipping is a fault, not speech."""
    rng = np.random.default_rng(0)
    saturated = np.clip(rng.normal(0, 0.7, 40_000), -1.0, 1.0).astype(np.float32)
    presence = assess(saturated)
    assert presence.clipped
    assert not presence.is_speech(THRESHOLD)
    assert presence.reason == "clipped"


def test_clean_speech_is_not_counted_as_clipped() -> None:
    presence = assess(speech())
    assert not presence.clipped
    assert presence.is_speech(THRESHOLD)
