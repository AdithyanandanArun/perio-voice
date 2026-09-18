"""Decides whether a segment contains speech before any recognizer sees it.

The energy endpointer cuts a segment whenever the level rises above the room, so
a suction pulse, a handpiece starting or an instrument clink becomes an
"utterance". Whisper's own no-speech estimate used to reject those, and it did on
tiny.en: 0.68-0.96 on noise against 0.02-0.50 on speech. With large-v3 and the
example prompt it does not. The prompt pulls the no-speech estimate on noise
down to 0.09-0.29, overlapping real speech (up to 0.12), and the model fills the
silence by reciting the prompt: measured on endpointed operatory noise bursts,
suction, handpiece, chair, scaler and babble came back as "b o p d three four
five." and "three four five." -- a bleeding finding and three depths from a
suction pulse.

So the question "is this speech?" is no longer left to the prompted model alone.
Three checks each catch what the others miss:

1. Saturation. A capture with more than 1% of samples at full scale is a fault
   (a broken microphone path produced exactly that: constant full-scale noise
   that large-v3 read as "b o p d three four five."). Refused, not guessed at.
2. Silero VAD, which ships with faster-whisper, runs on the CPU in about 2 ms a
   segment and never sees the prompt. The score is the highest 96 ms moving
   average of its per-window speech probability, so a single-window spike on
   noise does not count as speech but a syllable does. It rejects most bursts
   before any GPU time is spent; loud scaler whine still scores up to 0.88.
3. Whisper's own no-speech estimate with a threshold recalibrated for the
   prompted model (server/config.py). Every burst that got past Silero scored
   at least 0.174 there, while speech on the replay recordings scored at most
   0.122 -- they fail on different inputs, which is why both are used.

Measured on the replay recordings and 960 synthesized operatory bursts (six
sources, four durations, five levels, eight realizations). Two of 138 speech
segments, each a lone synthetic "four", fall below the Silero threshold. That is
the safe side to lose: the clinician repeats a word, whereas a burst that reaches
the recognizer can write a measurement.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import numpy as np

from server.audio import FloatAudio

WINDOW_SAMPLES = 512
"""Silero's window at 16 kHz; audio is padded up to a multiple of it."""
SUSTAIN_WINDOWS = 3
"""About 96 ms: a syllable sustains its speech probability this long; a noise
spike usually does not."""
CLIPPED_LEVEL = 0.99
MAX_CLIPPED_FRACTION = 0.01


@dataclass(frozen=True, slots=True)
class Presence:
    probability: float
    clipped_fraction: float

    @property
    def clipped(self) -> bool:
        return self.clipped_fraction > MAX_CLIPPED_FRACTION

    def is_speech(self, threshold: float) -> bool:
        return not self.clipped and self.probability >= threshold

    @property
    def reason(self) -> str:
        return "clipped" if self.clipped else "no_speech"


@lru_cache(maxsize=1)
def _model() -> Any:
    from faster_whisper.vad import get_vad_model

    return get_vad_model()


def speech_probability(audio: FloatAudio) -> float:
    """The highest sustained Silero speech probability over the segment."""
    if len(audio) == 0:
        return 0.0
    samples = np.asarray(audio, dtype=np.float32)
    padding = (-len(samples)) % WINDOW_SAMPLES
    if padding:
        samples = np.pad(samples, (0, padding))
    probabilities = np.asarray(_model()(samples), dtype=np.float32).reshape(-1)
    if probabilities.size == 0:
        return 0.0
    if probabilities.size < SUSTAIN_WINDOWS:
        return float(probabilities.mean())
    kernel = np.full(SUSTAIN_WINDOWS, 1.0 / SUSTAIN_WINDOWS, dtype=np.float32)
    return float(np.convolve(probabilities, kernel, mode="valid").max())


def assess(audio: FloatAudio) -> Presence:
    samples = np.asarray(audio, dtype=np.float32)
    clipped = float(np.mean(np.abs(samples) >= CLIPPED_LEVEL)) if samples.size else 0.0
    return Presence(speech_probability(samples), clipped)
