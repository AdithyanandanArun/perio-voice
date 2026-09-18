from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from server.audio import FloatAudio
from server.config import Settings
from server.prompt import dental_prompt


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
class Alternative:
    """A competing reading of the same audio, best first."""

    text: str
    confidence: float


@dataclass(frozen=True, slots=True)
class RecognitionResult:
    text: str
    decode_ms: int
    words: tuple[WordTiming, ...] = ()
    """Share of tokens the grammar could not account for. 1.0 means nothing fit."""
    unknown_ratio: float = 0.0
    """Whisper's own estimate that the audio is not speech at all."""
    no_speech_prob: float = 0.0
    engine: str = "whisper"
    """Competing readings, so clinical context can choose rather than the
    acoustics alone. Short clinical words are often genuinely ambiguous — "two"
    and "tooth" differ by one weak fricative — and the context knows which one is
    possible."""
    alternatives: tuple[Alternative, ...] = ()


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

    def __init__(self, settings: Settings, *, prompt: str | None = None) -> None:
        """`prompt` overrides the shared dental prompt; evaluation uses it to keep
        a historical baseline fixed when the shared prompt changes."""
        self.prompt_override = prompt
        self.model_name = settings.model_name
        self.device = settings.device
        self.compute_type = settings.compute_type
        self.language = settings.language
        self.model_dir = settings.model_dir
        self.bias_prompt = settings.bias_prompt
        self.word_timestamps = settings.word_timestamps
        self.beam_size = settings.beam_size
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

        if self.device == "cuda":
            from server.cuda_runtime import ensure_cuda_libraries

            ensure_cuda_libraries()

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
            beam_size=self.beam_size,
            best_of=self.beam_size,
            # No temperature pin: leaving faster-whisper's default fallback in
            # place lets a bad greedy decode retry instead of being returned.
            condition_on_previous_text=False,
            # Biasing costs nothing at decode time and is the cheapest available
            # defence against a general model substituting everyday English for
            # clinical vocabulary.
            initial_prompt=(self.prompt_override or dental_prompt()) if self.bias_prompt else None,
            word_timestamps=self.word_timestamps and not partial,
            vad_filter=False,
            without_timestamps=partial or not self.word_timestamps,
        )
        materialized = list(segments)
        text = " ".join(segment.text.strip() for segment in materialized).strip()
        # Whisper's own estimate that the audio was not speech. Measured to
        # separate silence, hiss, suction and handpieces (0.68-0.96) from real
        # speech (0.02-0.50); avg_logprob does not separate them and is not used.
        no_speech = max((float(segment.no_speech_prob) for segment in materialized), default=0.0)
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
            no_speech_prob=round(no_speech, 4),
            engine="whisper",
        )
