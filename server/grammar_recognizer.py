"""Grammar-constrained recognition.

Whisper decides what was said out of all English. Measured on spoken dental
phrases it is right about a quarter of the time at these utterance lengths, and
the model size barely matters — `base.en` scored below `tiny.en`. The problem is
not capacity, it is that a 30-second sequence model is being asked to resolve a
half-second command with no context.

This recognizer is given the vocabulary instead. Inside a grammar the decoder
chooses between the words a clinician could actually be saying, so "for" cannot
come back where four was meant and a handpiece cannot become "Bye bye.". Speech
that fits nothing in the grammar returns the unknown marker, which is a far more
useful answer than a confident wrong one.

It is deliberately not a replacement for Whisper everywhere: free-form clinical
speech still needs an open vocabulary, so `server/routing.py` decides which
engine answers.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from server.audio import FloatAudio
from server.config import Settings
from server.recognizer import Alternative, ModelStatus, RecognitionResult, WordTiming
from server.vocabulary import UNKNOWN_TOKEN, Expectation, grammar_for


def _to_pcm_bytes(audio: FloatAudio) -> bytes:
    import numpy as np

    clipped = np.clip(audio, -1.0, 1.0)
    return (clipped * 32_767.0).astype("<i2").tobytes()


def _clean_tokens(raw: object) -> tuple[str, int, int]:
    """Remove the explicit unknown marker before text reaches the pipeline."""
    tokens = str(raw or "").split()
    unknown = sum(1 for token in tokens if token == UNKNOWN_TOKEN)
    cleaned = " ".join(token for token in tokens if token != UNKNOWN_TOKEN).strip()
    return cleaned, unknown, len(tokens)


@dataclass(frozen=True, slots=True)
class _ParsedGrammarResult:
    result: RecognitionResult
    unknown_tokens: int
    token_count: int


class VoskGrammarSession:
    """An isolated incremental Vosk decoder for one speech segment.

    Each session owns its ``KaldiRecognizer``.  PCM frames can therefore be
    accepted while speech is in progress and the session can be finalized
    without touching Faster-Whisper's GPU decode lock.  The async methods run
    the small C++ calls off the event loop; ``*_sync`` methods are available to
    a worker that already runs outside the loop.
    """

    def __init__(
        self,
        recognizer: Any,
        *,
        sample_rate: int,
        max_alternatives: int,
    ) -> None:
        self._recognizer = recognizer
        self._sample_rate = sample_rate
        self._max_alternatives = max_alternatives
        self._lock = threading.Lock()
        self._closed = False
        self._final: RecognitionResult | None = None
        self._completed: list[_ParsedGrammarResult] = []
        self._semantic_complete = False

    @property
    def semantic_complete(self) -> bool:
        """Whether Vosk has accepted a complete phrase for this segment."""
        return self._semantic_complete

    @property
    def finalized(self) -> bool:
        return self._final is not None

    @property
    def closed(self) -> bool:
        return self._closed

    def _require_open(self) -> Any:
        if self._closed:
            raise RuntimeError("The grammar session is closed.")
        if self._final is not None:
            raise RuntimeError("The grammar session has already been finalized.")
        return self._recognizer

    def _result(
        self,
        payload: dict[str, Any],
        *,
        partial: bool,
        started: float,
    ) -> _ParsedGrammarResult:
        alternatives: tuple[Alternative, ...] = ()
        if "alternatives" in payload:
            ranked = [entry for entry in payload["alternatives"] if isinstance(entry, dict)]
            alternatives = tuple(
                Alternative(
                    text=_clean_tokens(entry.get("text", ""))[0],
                    confidence=round(float(entry.get("confidence", 0.0)), 4),
                )
                for entry in ranked
            )
            payload = ranked[0] if ranked else {"text": ""}

        raw_text = payload.get("partial", "") if partial else payload.get("text", "")
        text, unknown, token_count = _clean_tokens(raw_text)
        spoken = [
            entry
            for entry in payload.get("result", [])
            if isinstance(entry, dict) and entry.get("word")
        ]
        words = tuple(
            WordTiming(
                word=str(entry["word"]),
                start_ms=round(float(entry.get("start", 0.0)) * 1_000),
                end_ms=round(float(entry.get("end", 0.0)) * 1_000),
                probability=round(float(entry.get("conf", 0.0)), 4),
            )
            for entry in spoken
            if str(entry["word"]) != UNKNOWN_TOKEN
        )
        return _ParsedGrammarResult(
            result=RecognitionResult(
                text=text,
                decode_ms=round((time.perf_counter() - started) * 1_000),
                words=() if partial else words,
                unknown_ratio=(unknown / token_count) if token_count else 1.0,
                engine="grammar",
                alternatives=alternatives,
            ),
            unknown_tokens=unknown,
            token_count=token_count,
        )

    def _aggregate(
        self,
        current: _ParsedGrammarResult | None,
        *,
        partial: bool,
        started: float,
    ) -> RecognitionResult:
        items = [*self._completed]
        if current is not None:
            items.append(current)
        text = " ".join(item.result.text for item in items if item.result.text).strip()
        words = tuple(word for item in items for word in item.result.words)
        unknown = sum(item.unknown_tokens for item in items)
        token_count = sum(item.token_count for item in items)
        alternatives = current.result.alternatives if current is not None else ()
        return RecognitionResult(
            text=text,
            decode_ms=round((time.perf_counter() - started) * 1_000),
            words=() if partial else words,
            unknown_ratio=(unknown / token_count) if token_count else 1.0,
            engine="grammar",
            alternatives=alternatives,
        )

    def feed_pcm_sync(self, pcm: bytes) -> RecognitionResult:
        """Consume one PCM16 frame and return the current partial/result text."""
        if not isinstance(pcm, bytes):
            pcm = bytes(pcm)
        if not pcm:
            raise ValueError("Grammar PCM must not be empty.")
        if len(pcm) % 2:
            raise ValueError("Grammar PCM16 must contain complete samples.")
        with self._lock:
            recognizer = self._require_open()
            started = time.perf_counter()
            completed = bool(recognizer.AcceptWaveform(pcm))
            if completed:
                self._semantic_complete = True
            payload = json.loads(recognizer.Result() if completed else recognizer.PartialResult())
            if not isinstance(payload, dict):
                payload = {}
            parsed = self._result(payload, partial=not completed, started=started)
            if completed:
                self._completed.append(parsed)
                return self._aggregate(None, partial=False, started=started)
            return self._aggregate(parsed, partial=True, started=started)

    def finalize_sync(self) -> RecognitionResult:
        """Flush Vosk immediately and return the one final grammar result."""
        with self._lock:
            if self._final is not None:
                return self._final
            recognizer = self._require_open()
            started = time.perf_counter()
            payload = json.loads(recognizer.FinalResult())
            if not isinstance(payload, dict):
                payload = {}
            parsed = self._result(payload, partial=False, started=started)
            self._semantic_complete = True
            self._final = self._aggregate(parsed, partial=False, started=started)
            return self._final

    async def feed_pcm(self, pcm: bytes) -> RecognitionResult:
        """Async PCM entry point for live sessions."""
        return await asyncio.to_thread(self.feed_pcm_sync, pcm)

    async def finalize(self) -> RecognitionResult:
        """Async finalization that does not wait for a large-model decode."""
        return await asyncio.to_thread(self.finalize_sync)

    def close(self) -> None:
        """Release the C++ recognizer; final results remain available."""
        with self._lock:
            self._closed = True
            self._recognizer = None


class VoskGrammarRecognizer:
    """One lazily loaded Kaldi model, reconfigured per clinical context."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model_name = settings.grammar_model_dir.name
        self.device = "cpu"
        self.compute_type = "grammar"
        self.status = ModelStatus.IDLE
        self.error: str | None = None
        self._model: Any | None = None
        self._load_lock = asyncio.Lock()
        self._expectation = Expectation.CLINICAL

    @property
    def expectation(self) -> Expectation:
        return self._expectation

    def set_expectation(self, expectation: Expectation) -> None:
        """Narrows the grammar to what the active clinical context expects."""
        self._expectation = expectation

    def start_session(self, expectation: Expectation | None = None) -> VoskGrammarSession:
        """Create an isolated incremental session for the current context."""
        if self.status is not ModelStatus.READY or self._model is None:
            raise RuntimeError("The grammar recognition model is not ready.")
        selected = self._expectation if expectation is None else expectation
        from vosk import KaldiRecognizer

        recognizer = KaldiRecognizer(
            self._model,
            self.settings.sample_rate,
            json.dumps(list(grammar_for(selected))),
        )
        recognizer.SetWords(True)
        if self.settings.max_alternatives > 1:
            recognizer.SetMaxAlternatives(self.settings.max_alternatives)
        return VoskGrammarSession(
            recognizer,
            sample_rate=self.settings.sample_rate,
            max_alternatives=self.settings.max_alternatives,
        )

    async def open_session(self, expectation: Expectation | None = None) -> VoskGrammarSession:
        """Load lazily, then open a session for async streaming callers."""
        if self.status is not ModelStatus.READY:
            await self.load()
        return self.start_session(expectation)

    async def load(self) -> None:
        async with self._load_lock:
            if self.status is ModelStatus.READY:
                return
            self.status = ModelStatus.LOADING
            self.error = None
            try:
                self._model = await asyncio.to_thread(self._load_sync)
            except Exception as exc:
                self.status = ModelStatus.ERROR
                self.error = f"{type(exc).__name__}: {exc}"
                raise
            self.status = ModelStatus.READY

    def _load_sync(self) -> Any:
        from vosk import Model, SetLogLevel

        # Vosk logs lexicon problems on C-level stderr, which Python cannot
        # redirect. Silencing it here keeps the service log readable; coverage is
        # checked by scripts/verify_grammar_lexicon.py instead.
        SetLogLevel(-1)
        directory = Path(self.settings.grammar_model_dir)
        if not directory.is_dir():
            raise FileNotFoundError(
                f"Grammar model not found at {directory}. Run 'npm run setup' or "
                f"'uv run python scripts/fetch_grammar_model.py'."
            )
        return Model(str(directory))

    def lexicon_contains(self, word: str) -> bool:
        """True when the model can actually emit this word."""
        import os

        if self._model is None:
            raise RuntimeError("The grammar model is not loaded.")
        from vosk import KaldiRecognizer, SetLogLevel

        SetLogLevel(0)
        read_fd, write_fd = os.pipe()
        saved = os.dup(2)
        try:
            os.dup2(write_fd, 2)
            KaldiRecognizer(
                self._model, self.settings.sample_rate, json.dumps([word, UNKNOWN_TOKEN])
            )
        finally:
            os.dup2(saved, 2)
            os.close(write_fd)
            os.close(saved)
            SetLogLevel(-1)
        captured = os.read(read_fd, 1 << 16).decode(errors="replace")
        os.close(read_fd)
        return "missing in vocabulary" not in captured

    async def transcribe(
        self,
        audio: FloatAudio,
        *,
        partial: bool,
        beam_size: int | None = None,
    ) -> RecognitionResult:
        if self.status is not ModelStatus.READY or self._model is None:
            raise RuntimeError("The grammar recognition model is not ready.")
        return await asyncio.to_thread(self._transcribe_sync, audio, partial)

    def _transcribe_sync(self, audio: FloatAudio, partial: bool) -> RecognitionResult:
        session = self.start_session()
        try:
            pcm = _to_pcm_bytes(audio)
            if partial:
                return session.feed_pcm_sync(pcm)
            session.feed_pcm_sync(pcm)
            return session.finalize_sync()
        finally:
            session.close()
