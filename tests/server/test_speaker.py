"""Speaker attribution: what actually holds.

An earlier version of this file asserted that the gate separates the enrolled
speaker from another voice, using 5.5-second segments compared against
5.5-second segments. That is not the comparison the product makes, and at the
durations it does make the distributions invert — see `G33` in GATES.md, which is
abandoned rather than tuned, and EVALUATION.md for the measurements.

So this file tests the properties that do hold: enrollment completes from
ordinary speech, accumulates across takes, short utterances reach a decision,
the profile describes the voice rather than the level, and revocation works.
Discrimination is deliberately not asserted, because it is not true.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from faster_whisper.audio import decode_audio
from numpy.typing import NDArray

from server.config import Settings
from server.speaker import SpeakerDecision, SpeakerGate, correlation, profile

FIXTURE = Path("tests/fixtures/jfk.flac")
SETTINGS = Settings.from_env()


@pytest.fixture(scope="module")
def speech() -> NDArray[np.float32]:
    audio: NDArray[np.float32] = decode_audio(str(FIXTURE), sampling_rate=SETTINGS.sample_rate)
    return audio


def test_an_unenrolled_gate_never_claims_the_clinician(speech: NDArray[np.float32]) -> None:
    gate = SpeakerGate(SETTINGS)
    verdict = gate.verify(speech)
    assert verdict.decision is SpeakerDecision.UNKNOWN
    assert verdict.enrolled is False


def test_one_ordinary_take_completes_enrollment(speech: NDArray[np.float32]) -> None:
    """Six seconds of normal speech used to fall short and appear to need shouting."""
    gate = SpeakerGate(SETTINGS)
    state = gate.enroll(speech[: 6 * SETTINGS.sample_rate])
    assert state.enrolled is True
    assert state.voiced_ms >= state.required_ms


def test_short_takes_accumulate_rather_than_each_having_to_suffice(
    speech: NDArray[np.float32],
) -> None:
    gate = SpeakerGate(SETTINGS)
    chunk = int(1.2 * SETTINGS.sample_rate)
    for index in range(4):
        gate.enroll(speech[index * chunk : (index + 1) * chunk])
    assert gate.state().enrolled is True
    assert gate.state().samples == 4


def test_a_take_with_no_usable_speech_is_refused(speech: NDArray[np.float32]) -> None:
    gate = SpeakerGate(SETTINGS)
    with pytest.raises(ValueError, match="too"):
        gate.enroll(np.zeros(int(0.05 * SETTINGS.sample_rate), dtype=np.float32))
    assert gate.state().enrolled is False


def test_short_utterances_reach_a_decision_once_the_window_fills(
    speech: NDArray[np.float32],
) -> None:
    """ "three" carries about 300 ms of speech and used to be unverifiable."""
    gate = SpeakerGate(SETTINGS)
    gate.enroll(speech[: 6 * SETTINGS.sample_rate])
    gate.forget_window()
    width = int(0.6 * SETTINGS.sample_rate)
    decisions = [
        gate.verify(speech[6 * SETTINGS.sample_rate + index * width :][:width]).decision
        for index in range(8)
    ]
    assert any(decision is not SpeakerDecision.UNKNOWN for decision in decisions[3:])


def test_a_clip_longer_than_the_window_does_not_empty_it(speech: NDArray[np.float32]) -> None:
    gate = SpeakerGate(SETTINGS)
    gate.enroll(speech[: 6 * SETTINGS.sample_rate])
    gate.forget_window()
    verdict = gate.verify(speech)
    assert verdict.enrolled is True
    assert verdict.voiced_ms > 0


def test_resetting_revokes_the_profile(speech: NDArray[np.float32]) -> None:
    gate = SpeakerGate(SETTINGS)
    gate.enroll(speech[: 6 * SETTINGS.sample_rate])
    assert gate.state().enrolled is True
    state = gate.reset()
    assert state.enrolled is False
    assert state.samples == 0
    assert gate.verify(speech).decision is SpeakerDecision.UNKNOWN


def test_a_profile_describes_the_voice_rather_than_the_level(
    speech: NDArray[np.float32],
) -> None:
    """Level changes the profile only slightly, through frame selection.

    Voicing is now an absolute floor rather than a fraction of the clip's peak,
    which is what made enrollment achievable. The trade is that a quieter take
    keeps marginally fewer frames, so the profiles are very highly correlated
    rather than identical. Exact invariance was a property of the peak-relative
    detector that could not pass enrollment.
    """
    quiet = (speech * 0.3).astype(np.float32)
    loud = (speech * 0.9).astype(np.float32)
    left = profile(quiet, SETTINGS.sample_rate)
    right = profile(loud, SETTINGS.sample_rate)
    assert correlation(left.spectral, right.spectral) > 0.99
    assert correlation(left.cepstral, right.cepstral) > 0.99


def test_voicing_survives_a_loud_transient(speech: NDArray[np.float32]) -> None:
    """A knock on the microphone used to suppress the rest of the take."""
    take = speech[: 6 * SETTINGS.sample_rate].copy()
    clean = profile(take, SETTINGS.sample_rate).voiced_ms
    take[len(take) // 2] = 1.0
    assert profile(take, SETTINGS.sample_rate).voiced_ms >= clean * 0.9
