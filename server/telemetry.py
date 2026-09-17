"""Bounded, identifier-free runtime metrics.

Clinical speech is the most sensitive thing this service touches, so nothing
derived from what was said ever becomes a metric. Metric names come from a fixed
allowlist, which makes label cardinality bounded by construction rather than by
convention: an unknown name raises instead of quietly creating a new series.

Every value is a count or a duration. There are no transcripts, no audio, no
patient or clinician identifiers, and no free-form strings.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Final

COUNTERS: Final[frozenset[str]] = frozenset(
    {
        "connections_total",
        "streams_started",
        "utterances_total",
        "partials_total",
        "partials_dropped",
        "finals_total",
        "decode_errors",
        "invalid_audio",
        "model_loads",
        "model_load_failures",
        "speaker_clinician",
        "speaker_other",
        "speaker_unknown",
    }
)

HISTOGRAMS: Final[frozenset[str]] = frozenset(
    {
        "decode_ms_partial",
        "decode_ms_final",
        "queue_wait_ms",
        "audio_ms",
        "speech_ms",
        "end_silence_ms",
        "model_load_ms",
    }
)

"""Samples retained per histogram. Bounded so memory cannot grow with traffic."""
RESERVOIR: Final = 512


@dataclass(slots=True)
class Histogram:
    samples: deque[float] = field(default_factory=lambda: deque(maxlen=RESERVOIR))
    count: int = 0
    total: float = 0.0

    def observe(self, value: float) -> None:
        self.samples.append(value)
        self.count += 1
        self.total += value

    def percentile(self, fraction: float) -> float | None:
        if not self.samples:
            return None
        ordered = sorted(self.samples)
        index = max(0, min(len(ordered) - 1, round(fraction * (len(ordered) - 1))))
        return ordered[index]

    def as_message(self) -> dict[str, float | int | None]:
        return {
            "count": self.count,
            "mean": round(self.total / self.count, 2) if self.count else None,
            "p50": self.percentile(0.5),
            "p95": self.percentile(0.95),
            "p99": self.percentile(0.99),
            "max": max(self.samples) if self.samples else None,
        }


class Telemetry:
    """Process-wide counters and duration histograms."""

    def __init__(self) -> None:
        self._counters: dict[str, int] = dict.fromkeys(COUNTERS, 0)
        self._histograms: dict[str, Histogram] = {name: Histogram() for name in HISTOGRAMS}

    def count(self, name: str, amount: int = 1) -> None:
        if name not in self._counters:
            raise KeyError(f"Unknown telemetry counter: {name}")
        self._counters[name] += amount

    def observe(self, name: str, value: float) -> None:
        histogram = self._histograms.get(name)
        if histogram is None:
            raise KeyError(f"Unknown telemetry histogram: {name}")
        histogram.observe(value)

    def snapshot(self) -> dict[str, object]:
        return {
            "counters": dict(sorted(self._counters.items())),
            "histograms": {
                name: histogram.as_message() for name, histogram in sorted(self._histograms.items())
            },
        }

    def reset(self) -> None:
        for name in self._counters:
            self._counters[name] = 0
        for name in self._histograms:
            self._histograms[name] = Histogram()
