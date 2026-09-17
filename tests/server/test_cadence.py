"""Endpointing has to follow the speaker, not the other way round."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import numpy as np
import pytest

from server.cadence import CadenceController
from server.config import Settings
from server.recognizer import RecognitionResult, WordTiming
from server.session import AsrSession
from tests.server.fakes import FakeRecognizer


class PausedRecognizer(FakeRecognizer):
    """Returns word timings with short, even pauses, like a fast speaker."""

    async def transcribe(self, audio: Any, *, partial: bool) -> RecognitionResult:
        if partial:
            return RecognitionResult(text="three four", decode_ms=3)
        return RecognitionResult(
            text="three four five",
            decode_ms=5,
            words=(
                WordTiming("three", 0, 260, 0.96),
                WordTiming("four", 300, 560, 0.95),
                WordTiming("five", 600, 860, 0.94),
            ),
        )


SETTINGS = Settings.from_env()


def words(gaps_ms: list[int], word_ms: int = 260) -> tuple[WordTiming, ...]:
    """Builds word timings whose inter-word pauses are exactly `gaps_ms`."""
    timings: list[WordTiming] = []
    cursor = 0
    for index, gap in enumerate([0, *gaps_ms]):
        cursor += gap
        timings.append(WordTiming(f"w{index}", cursor, cursor + word_ms, 0.9))
        cursor += word_ms
    return tuple(timings)


def audio_ms(timings: tuple[WordTiming, ...]) -> int:
    return timings[-1].end_ms if timings else 0


def drive(controller: CadenceController, gaps: list[int], rounds: int = 8) -> int:
    spoken = words(gaps)
    for _ in range(rounds):
        controller.observe(spoken, audio_ms(spoken))
    return controller.end_silence_ms


def test_a_fast_speaker_shortens_the_endpoint() -> None:
    controller = CadenceController(SETTINGS)
    settled = drive(controller, [40, 50, 45, 60], rounds=10)
    assert settled < SETTINGS.end_silence_ms
    assert settled >= SETTINGS.endpoint_floor_ms


def test_a_deliberate_speaker_lengthens_the_endpoint() -> None:
    controller = CadenceController(SETTINGS)
    settled = drive(controller, [520, 600, 480, 560], rounds=10)
    assert settled > SETTINGS.end_silence_ms
    assert settled <= SETTINGS.endpoint_ceiling_ms


def test_the_endpoint_never_leaves_the_safe_band() -> None:
    controller = CadenceController(SETTINGS)
    for gaps in ([5, 5, 5, 5], [4_000, 4_000, 4_000], [10, 3_000, 15, 2_500]):
        settled = drive(controller, gaps, rounds=12)
        assert SETTINGS.endpoint_floor_ms <= settled <= SETTINGS.endpoint_ceiling_ms


def test_uneven_pacing_is_accommodated_rather_than_averaged() -> None:
    """One long pause in a fast utterance must not be cut off."""
    steady = CadenceController(SETTINGS)
    uneven = CadenceController(SETTINGS)
    drive(steady, [60, 70, 60, 65], rounds=10)
    drive(uneven, [60, 70, 60, 640], rounds=10)
    assert uneven.end_silence_ms > steady.end_silence_ms


def test_single_word_utterances_leave_the_endpoint_alone() -> None:
    """A one-word utterance carries no pause evidence, so it proves nothing."""
    controller = CadenceController(SETTINGS)
    one_word = (WordTiming("three", 0, 300, 0.95),)
    for _ in range(10):
        controller.observe(one_word, 300)
    assert controller.end_silence_ms == SETTINGS.end_silence_ms
    assert controller.state().samples == 10


def test_adaptation_can_be_switched_off() -> None:
    controller = CadenceController(replace(SETTINGS, cadence_adaptive=False))
    assert drive(controller, [900, 900, 900], rounds=10) == SETTINGS.end_silence_ms
    assert controller.state().adaptive is False


def test_the_controller_reports_what_it_measured() -> None:
    controller = CadenceController(SETTINGS)
    drive(controller, [200, 220, 210], rounds=4)
    state = controller.state()
    assert state.samples == 4
    assert state.pause_p90_ms >= 200
    assert state.words_per_second > 0
    message = state.as_message()
    assert set(message) == {
        "endSilenceMs",
        "wordsPerSecond",
        "pauseP90Ms",
        "samples",
        "adaptive",
    }


def test_resetting_returns_to_the_configured_starting_point() -> None:
    controller = CadenceController(SETTINGS)
    drive(controller, [900, 900, 900], rounds=6)
    assert controller.end_silence_ms != SETTINGS.end_silence_ms
    controller.reset()
    assert controller.end_silence_ms == SETTINGS.end_silence_ms


@pytest.mark.asyncio
async def test_a_finished_utterance_moves_the_live_endpoint() -> None:
    """The controller is only useful if the segmenter actually follows it."""
    recognizer = PausedRecognizer()
    await recognizer.load()
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    settings = replace(
        SETTINGS, vad_rms_threshold=0.01, pre_roll_ms=0, min_speech_ms=50, end_silence_ms=520
    )
    session = AsrSession(recognizer, settings, send)
    await session.start()
    frame = np.full(1_600, 6_000, dtype="<i2").tobytes()
    silence = np.zeros(1_600, dtype="<i2").tobytes()
    await session.feed(frame, 100)
    await session.feed(silence, 200)
    await session.stop(900)
    await session.close()

    final = next(message for message in messages if message["type"] == "final")
    assert final["cadence"]["adaptive"] is True
    assert session.segmenter.end_silence_ms == final["cadence"]["endSilenceMs"]
    assert session.segmenter.end_silence_ms < settings.end_silence_ms
