"""The replay harness is only evidence if its mixing and metrics are exact."""

from __future__ import annotations

import numpy as np
import pytest

from evaluation.noise import NOISE_SOURCES, measured_snr_db, mix_at_snr, rms, synthesize
from evaluation.wer import align, normalize, word_error_rate

SAMPLE_RATE = 16_000
SAMPLES = SAMPLE_RATE * 2


def speech_like() -> np.ndarray:
    time = np.arange(SAMPLES) / SAMPLE_RATE
    tone = sum(np.sin(2 * np.pi * 140 * k * time) / k for k in range(1, 10))
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 4 * time)
    return (tone / np.max(np.abs(tone)) * envelope * 0.6).astype(np.float32)


@pytest.mark.parametrize("source", sorted(NOISE_SOURCES))
def test_every_source_is_deterministic_and_normalized(source: str) -> None:
    first = synthesize(source, SAMPLES, SAMPLE_RATE, seed=7)
    second = synthesize(source, SAMPLES, SAMPLE_RATE, seed=7)
    assert np.array_equal(first, second)
    assert first.shape == (SAMPLES,)
    assert float(np.max(np.abs(first))) == pytest.approx(1.0, abs=1e-5)
    assert rms(first) > 0.01


def test_a_different_seed_gives_different_noise() -> None:
    assert not np.array_equal(
        synthesize("suction", SAMPLES, SAMPLE_RATE, seed=1),
        synthesize("suction", SAMPLES, SAMPLE_RATE, seed=2),
    )


def test_an_unknown_source_is_refused_rather_than_silently_skipped() -> None:
    with pytest.raises(KeyError, match="Unknown operatory noise source"):
        synthesize("drill_of_theseus", SAMPLES, SAMPLE_RATE)


@pytest.mark.parametrize("snr", [20.0, 10.0, 5.0, 0.0, -5.0])
def test_a_mixture_lands_on_the_ratio_it_was_asked_for(snr: float) -> None:
    speech = speech_like()
    noise = synthesize("babble", SAMPLES, SAMPLE_RATE, seed=3)
    mixture = mix_at_snr(speech, noise, snr)
    assert measured_snr_db(speech, mixture) == pytest.approx(snr, abs=0.05)
    assert float(np.max(np.abs(mixture.audio))) <= 1.0


def test_lower_ratios_really_do_bury_the_speech() -> None:
    speech = speech_like()
    noise = synthesize("handpiece", SAMPLES, SAMPLE_RATE, seed=4)
    loud = mix_at_snr(speech, noise, 20.0)
    quiet = mix_at_snr(speech, noise, 0.0)
    assert rms(quiet.audio - speech * quiet.speech_scale) > rms(
        loud.audio - speech * loud.speech_scale
    )


def test_noise_shorter_than_the_speech_is_tiled_rather_than_truncated() -> None:
    speech = speech_like()
    short = synthesize("hvac", SAMPLE_RATE // 2, SAMPLE_RATE, seed=5)
    mixture = mix_at_snr(speech, short, 10.0)
    assert mixture.audio.size == speech.size
    assert measured_snr_db(speech, mixture) == pytest.approx(10.0, abs=0.05)


class TestWordErrorRate:
    def test_identical_text_scores_zero(self) -> None:
        assert word_error_rate("three four five", "Three, four, five.") == 0.0

    def test_each_edit_type_is_counted_separately(self) -> None:
        counts = align(normalize("three four five"), normalize("three for five six"))
        assert counts.substitutions == 1
        assert counts.insertions == 1
        assert counts.deletions == 0
        assert counts.rate == pytest.approx(2 / 3)

    def test_a_dropped_word_is_a_deletion(self) -> None:
        counts = align(normalize("three four five"), normalize("three five"))
        assert counts.deletions == 1
        assert counts.rate == pytest.approx(1 / 3)

    def test_an_empty_reference_is_perfect_only_when_nothing_was_heard(self) -> None:
        assert word_error_rate("", "") == 0.0
        assert word_error_rate("", "thank you") == 1.0
