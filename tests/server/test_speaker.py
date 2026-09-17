"""Speaker attribution against real recorded speech.

The positive case is held-out speech from the enrolled speaker. The negative
case is the same recording resampled so pitch and formants move together, which
is a deliberately hard negative: it is a different voice that kept the original
speaking style, phrasing and recording channel.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
from faster_whisper.audio import decode_audio
from numpy.typing import NDArray

from server.config import Settings
from server.speaker import SpeakerDecision, SpeakerGate, correlation, profile

FIXTURE = Path("tests/fixtures/jfk.flac")
SETTINGS = Settings.from_env()


def _shift(audio: NDArray[np.float32], factor: float) -> NDArray[np.float32]:
    """Playback-rate change: a different voice, same speaking style."""
    count = int(len(audio) / factor)
    positions = np.arange(count) * factor
    lower = np.clip(np.floor(positions).astype(int), 0, len(audio) - 2)
    fraction = positions - lower
    shifted = (1 - fraction) * audio[lower] + fraction * audio[lower + 1]
    return shifted.astype(np.float32)


@pytest.fixture(scope="module")
def speech() -> NDArray[np.float32]:
    audio: NDArray[np.float32] = decode_audio(str(FIXTURE), sampling_rate=SETTINGS.sample_rate)
    return audio


@pytest.fixture(scope="module")
def enrolled(speech: NDArray[np.float32]) -> SpeakerGate:
    gate = SpeakerGate(SETTINGS)
    gate.enroll(speech)
    return gate


def _held_out(speech: NDArray[np.float32]) -> list[NDArray[np.float32]]:
    half = len(speech) // 2
    return [speech[:half], speech[half:], speech[int(0.2 * len(speech)) : int(0.7 * len(speech))]]


def _other_voices(speech: NDArray[np.float32]) -> list[NDArray[np.float32]]:
    segments: list[NDArray[np.float32]] = []
    for factor in (1.2, 1.3, 1.45, 0.8, 0.72):
        shifted = _shift(speech, factor)
        half = len(shifted) // 2
        segments.extend([shifted[:half], shifted[half:]])
    return segments


def test_an_unenrolled_gate_never_claims_the_clinician(speech: NDArray[np.float32]) -> None:
    gate = SpeakerGate(SETTINGS)
    verdict = gate.verify(speech)
    assert verdict.decision is SpeakerDecision.UNKNOWN
    assert verdict.enrolled is False


def test_enrollment_requires_enough_speech(speech: NDArray[np.float32]) -> None:
    gate = SpeakerGate(SETTINGS)
    with pytest.raises(ValueError, match="at least"):
        gate.enroll(speech[: SETTINGS.sample_rate // 4])
    assert gate.enrolled is False


def test_held_out_speech_from_the_enrolled_speaker_is_accepted(
    enrolled: SpeakerGate, speech: NDArray[np.float32]
) -> None:
    for segment in _held_out(speech):
        verdict = enrolled.verify(segment)
        assert verdict.decision is SpeakerDecision.CLINICIAN, verdict


def test_no_other_voice_is_ever_accepted(
    enrolled: SpeakerGate, speech: NDArray[np.float32]
) -> None:
    for segment in _other_voices(speech):
        verdict = enrolled.verify(segment)
        assert verdict.decision is not SpeakerDecision.CLINICIAN, verdict


def test_a_clearly_different_voice_is_rejected_outright(
    enrolled: SpeakerGate, speech: NDArray[np.float32]
) -> None:
    rejected = [
        enrolled.verify(segment).decision is SpeakerDecision.OTHER
        for segment in _other_voices(speech)
    ]
    assert all(rejected)


def test_the_configured_thresholds_sit_inside_the_measured_margin(
    enrolled: SpeakerGate, speech: NDArray[np.float32]
) -> None:
    """The gate is calibrated, not asserted: this measures the gap it relies on."""
    positive = min(enrolled.verify(segment).similarity for segment in _held_out(speech))
    negative = max(enrolled.verify(segment).similarity for segment in _other_voices(speech))
    assert negative < SETTINGS.speaker_reject < SETTINGS.speaker_accept <= positive
    assert positive - negative > 0.02


def test_too_little_speech_is_reported_rather_than_guessed(
    enrolled: SpeakerGate, speech: NDArray[np.float32]
) -> None:
    verdict = enrolled.verify(speech[: SETTINGS.sample_rate // 5])
    assert verdict.decision is SpeakerDecision.UNKNOWN
    assert verdict.voiced_ms < SETTINGS.speaker_min_ms


def test_resetting_revokes_the_profile(speech: NDArray[np.float32]) -> None:
    gate = SpeakerGate(SETTINGS)
    gate.enroll(speech)
    assert gate.state().enrolled is True
    state = gate.reset()
    assert state.enrolled is False
    assert state.samples == 0
    assert gate.verify(speech).decision is SpeakerDecision.UNKNOWN


def test_both_views_must_agree_before_a_voice_is_accepted(speech: NDArray[np.float32]) -> None:
    gate = SpeakerGate(replace(SETTINGS, speaker_accept=0.99, speaker_reject=0.98))
    gate.enroll(speech)
    verdict = gate.verify(_shift(speech, 1.3))
    assert min(verdict.spectral, verdict.cepstral) == pytest.approx(verdict.similarity)
    assert verdict.decision is SpeakerDecision.OTHER


def test_a_profile_describes_the_voice_rather_than_the_level(speech: NDArray[np.float32]) -> None:
    quiet = (speech * 0.3).astype(np.float32)
    loud = (speech * 0.9).astype(np.float32)
    left = profile(quiet, SETTINGS.sample_rate)
    right = profile(loud, SETTINGS.sample_rate)
    assert correlation(left.spectral, right.spectral) == pytest.approx(1.0, abs=1e-4)
    assert correlation(left.cepstral, right.cepstral) == pytest.approx(1.0, abs=1e-4)
