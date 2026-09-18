"""Routes each utterance to the engine that can actually answer it.

Routing is by declared clinical expectation, not by confidence. That keeps the
decision inspectable: while the chart is waiting for probing depths the grammar
answers and cannot emit anything else, and free-form dictation goes to Whisper
because it needs an open vocabulary. A confidence-based router would be harder to
reason about and would make the same utterance route differently on a rerun.
"""

from __future__ import annotations

from server.audio import FloatAudio
from server.config import Settings
from server.grammar_recognizer import VoskGrammarRecognizer
from server.recognizer import (
    FasterWhisperRecognizer,
    ModelStatus,
    RecognitionResult,
    Recognizer,
)
from server.routing import Engine
from server.vocabulary import Expectation


class RoutedRecognizer:
    """Presents one recognizer interface over the grammar and open-vocabulary engines."""

    def __init__(
        self,
        settings: Settings,
        whisper: Recognizer | None = None,
        grammar: VoskGrammarRecognizer | None = None,
    ) -> None:
        self.settings = settings
        self.engine = settings.engine
        self._whisper = whisper or FasterWhisperRecognizer(settings)
        self._grammar = grammar or VoskGrammarRecognizer(settings)
        self._expectation = Expectation.CLINICAL
        self.error: str | None = None
        # Plain attributes rather than properties, so this satisfies the
        # Recognizer protocol structurally. All three are fixed at construction.
        if settings.engine is Engine.WHISPER:
            self.model_name = self._whisper.model_name
        elif settings.engine is Engine.GRAMMAR:
            self.model_name = self._grammar.model_name
        else:
            self.model_name = f"{self._grammar.model_name} + {self._whisper.model_name}"
        self.device = self._whisper.device
        self.compute_type = self._whisper.compute_type

    # -- recognizer protocol surface -------------------------------------------------

    @property
    def status(self) -> ModelStatus:
        """Ready only when every engine this deployment can route to is ready."""
        states = [engine.status for engine in self._active_engines()]
        if any(state is ModelStatus.ERROR for state in states):
            return ModelStatus.ERROR
        if all(state is ModelStatus.READY for state in states):
            return ModelStatus.READY
        if any(state is ModelStatus.LOADING for state in states):
            return ModelStatus.LOADING
        return ModelStatus.IDLE

    @status.setter
    def status(self, value: ModelStatus) -> None:
        # The retry path in app.py sets this before reloading.
        for engine in self._active_engines():
            engine.status = value

    def _active_engines(self) -> list[Recognizer | VoskGrammarRecognizer]:
        if self.engine is Engine.WHISPER:
            return [self._whisper]
        if self.engine is Engine.GRAMMAR:
            return [self._grammar]
        return [self._grammar, self._whisper]

    async def load(self) -> None:
        errors: list[str] = []
        for engine in self._active_engines():
            try:
                await engine.load()
            except Exception as exc:
                errors.append(f"{type(exc).__name__}: {exc}")
        self.error = "; ".join(errors) if errors else None
        if errors:
            raise RuntimeError(self.error)

    # -- routing ---------------------------------------------------------------------

    @property
    def expectation(self) -> Expectation:
        return self._expectation

    def set_expectation(self, expectation: Expectation) -> None:
        self._expectation = expectation
        self._grammar.set_expectation(expectation)

    def route(self) -> str:
        """Which engine the current expectation selects."""
        if self.engine is Engine.WHISPER:
            return "whisper"
        if self.engine is Engine.GRAMMAR:
            return "grammar"
        return "whisper" if self._expectation is Expectation.FREE else "grammar"

    async def transcribe(self, audio: FloatAudio, *, partial: bool) -> RecognitionResult:
        chosen = self._whisper if self.route() == "whisper" else self._grammar
        return await chosen.transcribe(audio, partial=partial)
