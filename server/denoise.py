"""Swappable audio preprocessing profiles.

Operatory noise is not stationary room tone: suction, handpieces, scalers and
chair movement each occupy different parts of the spectrum and start and stop
constantly. Enhancement that helps one of them can hurt another, and aggressive
denoising removes exactly the short, low-energy consonants that distinguish
"four" from "for".

So preprocessing is a named profile rather than a fixed step, every profile is
measurable by `scripts/evaluate_acoustic.py`, and the default is `none`. A
profile is promoted only when replay shows it lowers word error at the SNR bands
that matter without hurting clean speech.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final

import numpy as np
from numpy.typing import NDArray

FloatAudio = NDArray[np.float32]

FRAME_MS: Final = 32
HOP_MS: Final = 8
"""Noise is estimated from this percentile of each bin's magnitude over time."""
NOISE_PERCENTILE: Final = 15.0
"""Subtraction factor. Above 1 it removes more than it measured, on purpose."""
OVER_SUBTRACTION: Final = 1.4
"""Never attenuate a bin below this fraction of its original magnitude."""
SPECTRAL_FLOOR: Final = 0.12
HIGHPASS_HZ: Final = 90.0
HIGHPASS_WIDTH_HZ: Final = 40.0


class DenoiseProfile(StrEnum):
    NONE = "none"
    HIGHPASS = "highpass"
    SPECTRAL = "spectral"


def highpass(audio: FloatAudio, sample_rate: int) -> FloatAudio:
    """Removes rumble from HVAC, chair motors and handling noise.

    The transition is a raised cosine rather than a brick wall, because a sharp
    cutoff rings and the ringing lands on plosives.
    """
    if audio.size == 0:
        return audio
    size = 1
    while size < audio.size:
        size *= 2
    spectrum = np.fft.rfft(audio, n=size)
    frequencies = np.fft.rfftfreq(size, d=1.0 / sample_rate)
    gain = np.ones_like(frequencies)
    stop = frequencies <= HIGHPASS_HZ - HIGHPASS_WIDTH_HZ / 2
    pass_band = frequencies >= HIGHPASS_HZ + HIGHPASS_WIDTH_HZ / 2
    transition = ~stop & ~pass_band
    gain[stop] = 0.0
    position = (frequencies[transition] - (HIGHPASS_HZ - HIGHPASS_WIDTH_HZ / 2)) / HIGHPASS_WIDTH_HZ
    gain[transition] = 0.5 - 0.5 * np.cos(np.pi * position)
    filtered = np.fft.irfft(spectrum * gain, n=size)[: audio.size]
    return filtered.astype(np.float32)


def spectral_subtraction(audio: FloatAudio, sample_rate: int) -> FloatAudio:
    """Estimates stationary noise from the quietest frames and subtracts it.

    The estimate is a low percentile per frequency bin over the whole utterance,
    which tracks continuous sources such as suction or HVAC. It does not help
    with an impulsive source, and the spectral floor keeps it from gating speech
    into silence when the estimate is wrong.
    """
    frame_len = int(sample_rate * FRAME_MS / 1000)
    hop = int(sample_rate * HOP_MS / 1000)
    if audio.size < frame_len * 2:
        return audio
    window = np.hanning(frame_len).astype(np.float32)
    count = 1 + (audio.size - frame_len) // hop
    indices = np.arange(frame_len)[None, :] + hop * np.arange(count)[:, None]
    frames = audio[indices] * window
    spectrum = np.fft.rfft(frames, axis=1)
    magnitude = np.abs(spectrum)
    phase = np.angle(spectrum)

    noise = np.percentile(magnitude, NOISE_PERCENTILE, axis=0)
    cleaned = np.maximum(magnitude - OVER_SUBTRACTION * noise, SPECTRAL_FLOOR * magnitude)
    restored = np.fft.irfft(cleaned * np.exp(1j * phase), n=frame_len, axis=1) * window

    output = np.zeros(audio.size, dtype=np.float32)
    weights = np.zeros(audio.size, dtype=np.float32)
    squared = (window * window).astype(np.float32)
    for index in range(count):
        start = index * hop
        output[start : start + frame_len] += restored[index].astype(np.float32)
        weights[start : start + frame_len] += squared
    tail = count * hop
    output[tail:] = audio[tail:]
    weights[tail:] = 1.0
    return (output / np.maximum(weights, 1e-6)).astype(np.float32)


def apply_profile(audio: FloatAudio, sample_rate: int, profile: DenoiseProfile) -> FloatAudio:
    if profile is DenoiseProfile.NONE:
        return audio
    if profile is DenoiseProfile.HIGHPASS:
        return highpass(audio, sample_rate)
    return spectral_subtraction(highpass(audio, sample_rate), sample_rate)


def parse_profile(value: str) -> DenoiseProfile:
    try:
        return DenoiseProfile(value.strip().lower())
    except ValueError as error:
        allowed = ", ".join(profile.value for profile in DenoiseProfile)
        raise ValueError(f"ASR_DENOISE_PROFILE must be one of: {allowed}.") from error
