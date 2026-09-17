from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from server.audio import FloatAudio
from server.config import Settings


class ModelStatus(StrEnum):
    IDLE = "idle"
    LOADING = "loading"
    READY = "ready"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class WordTiming:
    word: str
    start_ms: int
    end_ms: int
    probability: float


@dataclass(frozen=True, slots=True)
class RecognitionResult:
    text: str
    decode_ms: int
    words: tuple[WordTiming, ...] = ()


class Recognizer(Protocol):
    model_name: str
    device: str
    compute_type: str
    status: ModelStatus
    error: str | None

    async def load(self) -> None: ...

    async def transcribe(self, audio: FloatAudio, *, partial: bool) -> RecognitionResult: ...


class FasterWhisperRecognizer:
    """Lazy, serialized Faster-Whisper inference suitable for a local CPU demo."""

    def __init__(self, settings: Settings) -> None:
        self.model_name = settings.model_name
        self.device = settings.device
        self.compute_type = settings.compute_type
        self.language = settings.language
        self.model_dir = settings.model_dir
        self.status = ModelStatus.IDLE
        self.error: str | None = None
        self._model: object | None = None
        self._load_lock = asyncio.Lock()
        self._decode_lock = asyncio.Lock()

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

    def _load_sync(self) -> object:
        from faster_whisper import WhisperModel

        Path(self.model_dir).mkdir(parents=True, exist_ok=True)
        return WhisperModel(
            self.model_name,
            device=self.device,
            compute_type=self.compute_type,
            download_root=str(self.model_dir),
            local_files_only=False,
        )

    async def transcribe(self, audio: FloatAudio, *, partial: bool) -> RecognitionResult:
        if self.status is not ModelStatus.READY or self._model is None:
            raise RuntimeError("The recognition model is not ready.")
        async with self._decode_lock:
            return await asyncio.to_thread(self._transcribe_sync, audio, partial)

    def _transcribe_sync(self, audio: FloatAudio, partial: bool) -> RecognitionResult:
        started = time.perf_counter()
        model = self._model
        if model is None:
            raise RuntimeError("The recognition model is not ready.")
        segments, _ = model.transcribe(  # type: ignore[attr-defined]
            audio,
            language=self.language,
            beam_size=1,
            best_of=1,
            temperature=0.0,
            condition_on_previous_text=False,
            word_timestamps=not partial,
            vad_filter=False,
            without_timestamps=partial,
        )
        materialized = list(segments)
        text = " ".join(segment.text.strip() for segment in materialized).strip()
        words = tuple(
            WordTiming(
                word=word.word.strip(),
                start_ms=round(word.start * 1_000),
                end_ms=round(word.end * 1_000),
                probability=round(float(word.probability), 4),
            )
            for segment in materialized
            for word in (segment.words or [])
        )
        return RecognitionResult(
            text=text,
            decode_ms=round((time.perf_counter() - started) * 1_000),
            words=words,
        )
