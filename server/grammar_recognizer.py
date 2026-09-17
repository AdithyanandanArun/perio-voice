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
import time
from pathlib import Path
from typing import Any

from server.audio import FloatAudio
from server.config import Settings
from server.recognizer import ModelStatus, RecognitionResult, WordTiming
from server.vocabulary import UNKNOWN_TOKEN, Expectation, grammar_for


def _to_pcm_bytes(audio: FloatAudio) -> bytes:
    import numpy as np

    clipped = np.clip(audio, -1.0, 1.0)
    return (clipped * 32_767.0).astype("<i2").tobytes()


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

    async def transcribe(self, audio: FloatAudio, *, partial: bool) -> RecognitionResult:
        if self.status is not ModelStatus.READY or self._model is None:
            raise RuntimeError("The grammar recognition model is not ready.")
        return await asyncio.to_thread(self._transcribe_sync, audio, partial)

    def _transcribe_sync(self, audio: FloatAudio, partial: bool) -> RecognitionResult:
        from vosk import KaldiRecognizer

        started = time.perf_counter()
        recognizer = KaldiRecognizer(
            self._model,
            self.settings.sample_rate,
            json.dumps(list(grammar_for(self._expectation))),
        )
        recognizer.SetWords(True)
        recognizer.AcceptWaveform(_to_pcm_bytes(audio))
        payload = json.loads(recognizer.FinalResult())

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
        tokens = str(payload.get("text", "")).split()
        unknown = sum(1 for token in tokens if token == UNKNOWN_TOKEN)
        text = " ".join(token for token in tokens if token != UNKNOWN_TOKEN).strip()
        return RecognitionResult(
            text=text,
            decode_ms=round((time.perf_counter() - started) * 1_000),
            words=() if partial else words,
            unknown_ratio=(unknown / len(tokens)) if tokens else 1.0,
            engine="grammar",
        )
