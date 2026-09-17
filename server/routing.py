"""Which recognizer answers.

Two engines with opposite strengths. The grammar recognizer is accurate and fast
on the closed clinical vocabulary and returns the unknown marker for anything
else. Whisper is slower and much less accurate on short commands, but it has an
open vocabulary, which is what free-form clinical speech needs.

Routing is by declared clinical expectation rather than by confidence, so the
decision is inspectable and reproducible: while the chart is waiting for probing
depths the grammar answers, and it is structurally unable to invent a value that
the context has no room for.
"""

from __future__ import annotations

from enum import StrEnum


class Engine(StrEnum):
    """Which recognizer a deployment uses."""

    GRAMMAR = "grammar"
    WHISPER = "whisper"
    """Grammar for clinical context, Whisper when the vocabulary must stay open."""
    AUTO = "auto"


def parse_engine(value: str) -> Engine:
    try:
        return Engine(value.strip().lower())
    except ValueError as error:
        allowed = ", ".join(engine.value for engine in Engine)
        raise ValueError(f"ASR_ENGINE must be one of: {allowed}.") from error
