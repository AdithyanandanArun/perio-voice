"""Direct coverage for :mod:`server.routed_recognizer`'s terminal routing (F7).

``terminal_route``/``terminal_model`` is the guarantee that a GPU deployment's
chart-eligible result always comes from Whisper, never from the grammar hint
side channel, regardless of the declared clinical expectation. Nothing in
``tests/server/test_session.py`` isolates that property from the rest of the
session; these tests exercise the router directly against both the CUDA/
large-v3 cases and the CPU/AUTO fallback the property must leave unchanged.
"""

from __future__ import annotations

from typing import Any, cast

import pytest

from server.config import Settings
from server.recognizer import ModelStatus, RecognitionResult
from server.routed_recognizer import RoutedRecognizer
from server.routing import Engine
from server.vocabulary import Expectation


class _FakeWhisper:
    model_name = "large-v3"
    device = "cuda"
    compute_type = "int8_float16"
    status = ModelStatus.READY
    error: str | None = None

    async def load(self) -> None:
        self.status = ModelStatus.READY

    async def transcribe(
        self, _audio: Any, *, partial: bool, beam_size: int | None = None
    ) -> RecognitionResult:
        del partial, beam_size
        return RecognitionResult(text="WHISPER", decode_ms=1, engine="whisper")


class _FakeGrammar:
    model_name = "vosk-test"
    device = "cpu"
    compute_type = "grammar"
    status = ModelStatus.READY
    error: str | None = None

    async def load(self) -> None:
        self.status = ModelStatus.READY

    def set_expectation(self, _expectation: object) -> None:
        return

    async def transcribe(
        self, _audio: Any, *, partial: bool, beam_size: int | None = None
    ) -> RecognitionResult:
        del partial, beam_size
        return RecognitionResult(text="GRAMMAR", decode_ms=1, engine="grammar")


def _make(
    *,
    engine: Engine = Engine.AUTO,
    device: str = "cpu",
    model_name: str = "tiny.en",
) -> RoutedRecognizer:
    settings = Settings(engine=engine, device=device, model_name=model_name)
    return RoutedRecognizer(
        settings,
        whisper=cast(Any, _FakeWhisper()),
        grammar=cast(Any, _FakeGrammar()),
    )


@pytest.mark.parametrize("expectation", [Expectation.CLINICAL, Expectation.FREE])
def test_terminal_route_is_whisper_for_cuda_device_regardless_of_expectation(
    expectation: Expectation,
) -> None:
    """CUDA always terminates in Whisper, whichever expectation is declared."""
    recognizer = _make(engine=Engine.AUTO, device="cuda", model_name="tiny.en")
    recognizer.set_expectation(expectation)
    assert recognizer.terminal_route == "whisper"
    assert recognizer.terminal_model is recognizer._whisper


@pytest.mark.parametrize("expectation", [Expectation.CLINICAL, Expectation.FREE])
def test_terminal_route_is_whisper_for_large_v3_model_regardless_of_expectation(
    expectation: Expectation,
) -> None:
    """A large-v3 model name alone (even on a CPU device) forces the Whisper
    terminal route, matching the deployed GPU profile's intent even if the
    device string were ever misreported."""
    recognizer = _make(engine=Engine.AUTO, device="cpu", model_name="large-v3")
    recognizer.set_expectation(expectation)
    assert recognizer.terminal_route == "whisper"
    assert recognizer.terminal_model is recognizer._whisper


def test_terminal_route_is_whisper_for_explicit_whisper_engine() -> None:
    recognizer = _make(engine=Engine.WHISPER, device="cpu", model_name="tiny.en")
    recognizer.set_expectation(Expectation.CLINICAL)
    assert recognizer.terminal_route == "whisper"
    assert recognizer.terminal_model is recognizer._whisper


def test_explicit_cpu_auto_clinical_routing_keeps_previous_grammar_fallback() -> None:
    """Explicit CPU/AUTO routing (no CUDA, no large-v3) is unchanged by the GPU
    guard: CLINICAL still answers from grammar, and FREE still answers from
    Whisper, exactly as ``route()`` always selected."""
    recognizer = _make(engine=Engine.AUTO, device="cpu", model_name="tiny.en")

    recognizer.set_expectation(Expectation.CLINICAL)
    assert recognizer.terminal_route == "grammar"
    assert recognizer.terminal_model is recognizer._grammar

    recognizer.set_expectation(Expectation.FREE)
    assert recognizer.terminal_route == "whisper"
    assert recognizer.terminal_model is recognizer._whisper


def test_explicit_grammar_engine_terminates_in_grammar() -> None:
    """An operator who explicitly pins ``ASR_ENGINE=grammar`` gets a grammar
    terminal route: the CUDA/large-v3 guard only ever forces Whisper, it never
    forces grammar, so this configuration is left alone."""
    recognizer = _make(engine=Engine.GRAMMAR, device="cpu", model_name="tiny.en")
    recognizer.set_expectation(Expectation.CLINICAL)
    assert recognizer.terminal_route == "grammar"
    assert recognizer.terminal_model is recognizer._grammar


@pytest.mark.asyncio
async def test_transcribe_delegates_to_the_terminal_model_only() -> None:
    """``transcribe`` must go through ``terminal_model``, not ``route()``, so a
    CUDA deployment's transcript always carries the Whisper engine tag even
    while a grammar hint session is separately open."""
    recognizer = _make(engine=Engine.AUTO, device="cuda", model_name="tiny.en")
    recognizer.set_expectation(Expectation.CLINICAL)
    result = await recognizer.transcribe(cast(Any, object()), partial=False)
    assert result.engine == "whisper"
