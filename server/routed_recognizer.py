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
from server.grammar_recognizer import VoskGrammarRecognizer, VoskGrammarSession
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
        self.runtime_profile = getattr(self._whisper, "runtime_profile", None)
        self.cuda_capabilities = getattr(self._whisper, "cuda_capabilities", None)

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
        # The GPU profile commits through Whisper, but warming the optional
        # grammar side channel during service startup keeps its first utterance
        # from paying a model-load penalty. A missing grammar model must not
        # make a healthy terminal Whisper deployment unavailable.
        if (
            self.engine is Engine.WHISPER
            and (
                self.settings.device.strip().lower() == "cuda"
                or self.settings.model_name == "large-v3"
            )
            and self._grammar.status is not ModelStatus.READY
        ):
            try:
                await self._grammar.load()
            except Exception:
                pass
        self.error = "; ".join(errors) if errors else None
        if errors:
            raise RuntimeError(self.error)

    @property
    def warmup(self) -> object:
        """Warmup metadata for the active route, without retaining any audio."""
        active = self._active_engines()
        if len(active) == 1:
            return getattr(active[0], "warmup", None)
        return tuple(getattr(engine, "warmup", None) for engine in active)

    @property
    def runtime_metadata(self) -> dict[str, object]:
        """Route/model facts without exposing transcripts or audio."""
        metadata: dict[str, object] = {
            "model": self.model_name,
            "device": self.device,
            "computeType": self.compute_type,
            "warmup": self._warmup_metadata(self.warmup),
        }
        if self.runtime_profile is not None:
            as_dict = getattr(self.runtime_profile, "as_dict", None)
            metadata["profile"] = as_dict() if callable(as_dict) else self.runtime_profile
        if self.cuda_capabilities is not None:
            as_dict = getattr(self.cuda_capabilities, "as_dict", None)
            metadata["cuda"] = as_dict() if callable(as_dict) else self.cuda_capabilities
        return metadata

    @classmethod
    def _warmup_metadata(cls, value: object) -> object:
        if isinstance(value, tuple):
            return [cls._warmup_metadata(item) for item in value]
        as_dict = getattr(value, "as_dict", None)
        if callable(as_dict):
            return as_dict()
        return None

    @property
    def grammar(self) -> VoskGrammarRecognizer:
        """Expose the separate CPU grammar engine without changing routing."""
        return self._grammar

    async def start_grammar_session(
        self,
        expectation: Expectation | None = None,
    ) -> VoskGrammarSession:
        """Open the isolated fast path, loading Vosk lazily on Whisper routes."""
        return await self._grammar.open_session(expectation)

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

    @property
    def terminal_route(self) -> str:
        """Return the engine allowed to produce a committing result.

        The GPU profile is deliberately a Whisper terminal route.  The grammar
        engine may still be opened as an incremental hint session, but it must
        never silently replace the configured large-v3 decode at the commit
        boundary.  CPU deployments retain the explicit ``ASR_ENGINE``/context
        routing behaviour for backwards compatibility.
        """
        if (
            self.engine is Engine.WHISPER
            or self.settings.device.strip().lower() == "cuda"
            or self.settings.model_name == "large-v3"
        ):
            return "whisper"
        return self.route()

    @property
    def terminal_model(self) -> Recognizer:
        """The recognizer used for terminal, chart-eligible results."""
        return self._whisper if self.terminal_route == "whisper" else self._grammar

    async def transcribe(
        self,
        audio: FloatAudio,
        *,
        partial: bool,
        beam_size: int | None = None,
    ) -> RecognitionResult:
        chosen = self.terminal_model
        if beam_size is None:
            # Keep compatibility with injected recognizers used by the service
            # tests; the optional override is only needed by sweep callers.
            return await chosen.transcribe(audio, partial=partial)
        return await chosen.transcribe(audio, partial=partial, beam_size=beam_size)
