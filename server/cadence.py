"""Cadence-adaptive endpointing.

Clinicians speak at very different speeds, and the same clinician changes speed
within one appointment. A fixed end-of-speech silence has to be set for the
slowest of them, which makes everyone else wait, or for the fastest, which cuts
off the last value of a deliberate "three... four... five".

The controller watches how the speaker actually paces themselves — from the word
timestamps the recognizer already produces — and moves the endpoint threshold
inside a safe band. It tracks the high percentile of pauses rather than the mean,
because clipping a value the clinician was midway through saying is far worse
than waiting an extra hundred milliseconds.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from itertools import pairwise
from typing import Final

from server.audio import (
    SEMANTIC_HANGOVER_MAX_MS,
    SEMANTIC_HANGOVER_MIN_MS,
    SEMANTIC_HANGOVER_MS,
)
from server.config import Settings
from server.recognizer import WordTiming

"""Pauses are multiplied by this before becoming the endpoint budget."""
PAUSE_HEADROOM: Final = 1.6
"""Constant allowance for recognizer timestamp jitter, in milliseconds."""
TIMING_MARGIN_MS: Final = 180
FAST_WORDS_PER_SECOND: Final = 3.0
SLOW_WORDS_PER_SECOND: Final = 1.5
FAST_SCALE: Final = 0.85
SLOW_SCALE: Final = 1.15
"""Exponential smoothing on the threshold, so one odd utterance cannot swing it."""
SMOOTHING: Final = 0.4
# This is intentionally separate from the adaptive endpoint.  It is only
# selected when a semantic layer explicitly says that the current command is
# complete; ordinary speech, including a pause between values, continues to
# use the measured cadence budget.
# The semantic-hangover constants live in server.audio, where the segmenter
# applies the same budget.  Re-exporting them here keeps cadence callers from
# inventing a second source of truth without introducing an audio↔cadence
# import cycle.


@dataclass(frozen=True, slots=True)
class CadenceState:
    end_silence_ms: int
    words_per_second: float
    pause_p90_ms: int
    samples: int
    adaptive: bool
    semantic_complete: bool = False

    def as_message(self) -> dict[str, object]:
        message: dict[str, object] = {
            "endSilenceMs": self.end_silence_ms,
            "wordsPerSecond": round(self.words_per_second, 2),
            "pauseP90Ms": self.pause_p90_ms,
            "samples": self.samples,
            "adaptive": self.adaptive,
        }
        # Keep the v1 cadence payload stable for ordinary finals.  The extra
        # field is additive and appears only when a caller explicitly supplied
        # the semantic-complete hint that selected the short hangover.
        if self.semantic_complete:
            message["semanticComplete"] = True
        return message


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round(fraction * (len(ordered) - 1))))
    return ordered[index]


class CadenceController:
    """Keeps a short rolling view of one speaker's pacing."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._pauses: deque[float] = deque(maxlen=settings.cadence_window * 8)
        self._rates: deque[float] = deque(maxlen=settings.cadence_window)
        self._end_silence_ms = float(settings.end_silence_ms)
        self._samples = 0

    @property
    def end_silence_ms(self) -> int:
        return round(self._end_silence_ms)

    def state(self, *, semantic_complete: bool = False) -> CadenceState:
        end_silence_ms = (
            max(
                SEMANTIC_HANGOVER_MIN_MS,
                min(SEMANTIC_HANGOVER_MAX_MS, SEMANTIC_HANGOVER_MS),
            )
            if semantic_complete
            else self.end_silence_ms
        )
        return CadenceState(
            end_silence_ms=end_silence_ms,
            words_per_second=self._rates[-1] if self._rates else 0.0,
            pause_p90_ms=round(_percentile(list(self._pauses), 0.9)),
            samples=self._samples,
            adaptive=self.settings.cadence_adaptive,
            semantic_complete=semantic_complete,
        )

    def observe(
        self,
        words: tuple[WordTiming, ...],
        audio_ms: int,
        semantic_complete: bool = False,
        *,
        semantic_complete_hint: bool | None = None,
    ) -> CadenceState:
        """Folds one finished utterance into the estimate."""
        if semantic_complete_hint is True:
            semantic_complete = True
        if not self.settings.cadence_adaptive:
            return self.state(semantic_complete=semantic_complete)
        self._samples += 1
        if audio_ms > 0 and words:
            self._rates.append(len(words) / (audio_ms / 1000.0))
        for previous, following in pairwise(words):
            gap = float(following.start_ms - previous.end_ms)
            if gap >= 0:
                self._pauses.append(gap)

        # A single-word utterance carries no pause evidence, so the threshold is
        # left where it is rather than collapsing toward the floor.
        if len(self._pauses) < 2:
            return self.state(semantic_complete=semantic_complete)

        budget = _percentile(list(self._pauses), 0.9) * PAUSE_HEADROOM + TIMING_MARGIN_MS
        rate = sum(self._rates) / len(self._rates) if self._rates else 0.0
        if rate >= FAST_WORDS_PER_SECOND:
            budget *= FAST_SCALE
        elif 0 < rate <= SLOW_WORDS_PER_SECOND:
            budget *= SLOW_SCALE
        floor = float(self.settings.endpoint_floor_ms)
        ceiling = float(self.settings.endpoint_ceiling_ms)
        target = min(ceiling, max(floor, budget))
        self._end_silence_ms += SMOOTHING * (target - self._end_silence_ms)
        self._end_silence_ms = min(ceiling, max(floor, self._end_silence_ms))
        return self.state(semantic_complete=semantic_complete)

    def endpoint_ms(
        self,
        *,
        semantic_complete: bool = False,
        semantic_complete_hint: bool | None = None,
    ) -> int:
        """Return the endpoint budget without mutating cadence history.

        A semantic-complete hint is deliberately one-shot at the call site;
        this method does not persist it into the next utterance.  The returned
        short value is fixed inside the 120--200 ms contract, while no hint
        returns the adaptive value currently learned from word pauses.
        """
        if semantic_complete_hint is True:
            semantic_complete = True
        return self.state(semantic_complete=semantic_complete).end_silence_ms

    def reset(self) -> None:
        self._pauses.clear()
        self._rates.clear()
        self._end_silence_ms = float(self.settings.end_silence_ms)
        self._samples = 0
