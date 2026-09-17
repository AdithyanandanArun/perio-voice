"""Reproducible operatory noise.

Real clinics are not quiet rooms with stationary hiss. Suction pulses, a
handpiece whines, a scaler adds a fixed high tone, the chair motor rumbles, HVAC
runs continuously and people talk nearby. Each of those occupies a different part
of the spectrum, so a preprocessing profile that helps one can hurt another.

Every generator here is deterministic given its seed, so a replay result can be
reproduced exactly and two profiles can be compared on identical audio. These
are synthesized approximations of the recorded sources described in
ARCHITECTURE.md, not recordings; they are for relative comparison between
profiles and SNR bands, and a promotion decision for a real clinic needs real
recordings.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

import numpy as np
import numpy.typing as npt
from numpy.typing import NDArray

FloatAudio = NDArray[np.float32]

EPSILON: Final = 1e-12


def rms(audio: FloatAudio) -> float:
    if audio.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))


def _as_audio(values: npt.ArrayLike) -> FloatAudio:
    rendered: FloatAudio = np.asarray(values, dtype=np.float32)
    return rendered


def _white(samples: int, rng: np.random.Generator) -> FloatAudio:
    return _as_audio(rng.standard_normal(samples))


def _shape(noise: FloatAudio, gain: NDArray[np.float64]) -> FloatAudio:
    spectrum = np.fft.rfft(noise)
    return _as_audio(np.fft.irfft(spectrum * gain, n=noise.size))


def _bandpass_gain(
    frequencies: NDArray[np.float64], low: float, high: float
) -> NDArray[np.float64]:
    """Smooth band gain; smooth edges avoid the ringing a brick wall produces."""
    centre = float(np.sqrt(low * high))
    width = max(high - low, 1.0)
    gain: NDArray[np.float64] = np.exp(
        -np.square(frequencies - centre) / (2.0 * np.square(width / 2.5))
    )
    return gain


def _envelope(
    samples: int, sample_rate: int, rate_hz: float, depth: float, seed: int
) -> NDArray[np.float64]:
    time = np.arange(samples) / sample_rate
    rng = np.random.default_rng(seed)
    phase = rng.uniform(0, 2 * np.pi)
    return 1.0 - depth + depth * (0.5 + 0.5 * np.sin(2 * np.pi * rate_hz * time + phase))


def hvac(samples: int, sample_rate: int, rng: np.random.Generator) -> FloatAudio:
    """Continuous broadband room noise with a 1/f tilt."""
    frequencies = np.fft.rfftfreq(samples, d=1.0 / sample_rate)
    gain = 1.0 / np.sqrt(np.maximum(frequencies, 20.0))
    return _shape(_white(samples, rng), gain)


def chair(samples: int, sample_rate: int, rng: np.random.Generator) -> FloatAudio:
    """Low-frequency motor rumble that starts and stops."""
    frequencies = np.fft.rfftfreq(samples, d=1.0 / sample_rate)
    shaped = _shape(_white(samples, rng), _bandpass_gain(frequencies, 35.0, 140.0))
    return _as_audio(shaped * _envelope(samples, sample_rate, 0.4, 0.9, 11))


def suction(samples: int, sample_rate: int, rng: np.random.Generator) -> FloatAudio:
    """Mid-band turbulence, pulsing as the tip moves."""
    frequencies = np.fft.rfftfreq(samples, d=1.0 / sample_rate)
    shaped = _shape(_white(samples, rng), _bandpass_gain(frequencies, 300.0, 3_000.0))
    return _as_audio(shaped * _envelope(samples, sample_rate, 1.7, 0.5, 12))


def handpiece(samples: int, sample_rate: int, rng: np.random.Generator) -> FloatAudio:
    """A high whine with harmonics over broadband bearing noise."""
    time = np.arange(samples) / sample_rate
    tone = np.zeros(samples, dtype=np.float64)
    for harmonic, weight in ((1, 1.0), (2, 0.45), (3, 0.2)):
        tone += weight * np.sin(2 * np.pi * 2_400.0 * harmonic * time)
    frequencies = np.fft.rfftfreq(samples, d=1.0 / sample_rate)
    broadband = _shape(_white(samples, rng), _bandpass_gain(frequencies, 1_500.0, 6_500.0))
    combined = 0.7 * tone / np.max(np.abs(tone)) + 0.3 * broadband / (
        np.max(np.abs(broadband)) or 1
    )
    return _as_audio(combined * _envelope(samples, sample_rate, 0.6, 0.7, 13))


def scaler(samples: int, sample_rate: int, rng: np.random.Generator) -> FloatAudio:
    """The audible component of an ultrasonic scaler: a steady high tone plus hiss."""
    time = np.arange(samples) / sample_rate
    tone = np.sin(2 * np.pi * 6_300.0 * time) + 0.3 * np.sin(2 * np.pi * 5_100.0 * time)
    frequencies = np.fft.rfftfreq(samples, d=1.0 / sample_rate)
    hiss = _shape(_white(samples, rng), _bandpass_gain(frequencies, 4_000.0, 7_500.0))
    combined = 0.6 * tone / np.max(np.abs(tone)) + 0.4 * hiss / (np.max(np.abs(hiss)) or 1)
    return _as_audio(combined * _envelope(samples, sample_rate, 0.25, 0.35, 14))


def babble(samples: int, sample_rate: int, rng: np.random.Generator) -> FloatAudio:
    """Speech-shaped noise with syllabic modulation: nearby conversation."""
    frequencies = np.fft.rfftfreq(samples, d=1.0 / sample_rate)
    gain = _bandpass_gain(frequencies, 200.0, 3_500.0) + 0.3 * _bandpass_gain(
        frequencies, 500.0, 1_200.0
    )
    shaped = _shape(_white(samples, rng), gain)
    modulation = _envelope(samples, sample_rate, 4.2, 0.6, 15) * _envelope(
        samples, sample_rate, 0.9, 0.3, 16
    )
    return _as_audio(shaped * modulation)


NOISE_SOURCES: Final[dict[str, Callable[[int, int, np.random.Generator], FloatAudio]]] = {
    "hvac": hvac,
    "chair": chair,
    "suction": suction,
    "handpiece": handpiece,
    "scaler": scaler,
    "babble": babble,
}


def synthesize(name: str, samples: int, sample_rate: int, seed: int = 0) -> FloatAudio:
    source = NOISE_SOURCES.get(name)
    if source is None:
        raise KeyError(f"Unknown operatory noise source: {name}")
    rendered = source(samples, sample_rate, np.random.default_rng(seed))
    peak = float(np.max(np.abs(rendered))) if rendered.size else 0.0
    return (rendered / peak).astype(np.float32) if peak > 0 else rendered


@dataclass(frozen=True, slots=True)
class Mixture:
    """A noisy rendering plus the gain that was applied to avoid clipping.

    The gain is kept because it is applied to speech and noise together. Without
    it, recovering the achieved ratio from the mixture would silently treat the
    attenuated speech as extra noise.
    """

    audio: FloatAudio
    speech_scale: float
    requested_snr_db: float


def mix_at_snr(speech: FloatAudio, noise: FloatAudio, snr_db: float) -> Mixture:
    """Scales the noise so the mixture has exactly the requested speech-to-noise ratio."""
    if noise.size < speech.size:
        repeats = int(np.ceil(speech.size / max(noise.size, 1)))
        noise = np.tile(noise, repeats)
    noise = noise[: speech.size]
    speech_power = rms(speech)
    noise_power = rms(noise)
    if noise_power <= EPSILON or speech_power <= EPSILON:
        return Mixture(speech, 1.0, snr_db)
    target = speech_power / (10.0 ** (snr_db / 20.0))
    mixed = speech + noise * (target / noise_power)
    peak = float(np.max(np.abs(mixed)))
    scale = 1.0 / peak if peak > 1.0 else 1.0
    return Mixture(_as_audio(mixed * scale), scale, snr_db)


def measured_snr_db(speech: FloatAudio, mixture: Mixture) -> float:
    """Recovers the achieved ratio, so a report states what was actually tested."""
    scaled_speech = speech[: mixture.audio.size] * mixture.speech_scale
    residual = mixture.audio[: speech.size] - scaled_speech
    speech_power = rms(_as_audio(scaled_speech))
    noise_power = rms(_as_audio(residual))
    if noise_power <= EPSILON:
        return float("inf")
    return float(20.0 * np.log10(speech_power / noise_power))
