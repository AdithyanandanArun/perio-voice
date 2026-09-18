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


@dataclass(frozen=True, slots=True)
class WarmupInfo:
    """The readiness proof for one loaded model, without retaining audio/text."""

    completed: bool
    duration_ms: int | None
    error: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "completed": self.completed,
            "durationMs": self.duration_ms,
            "error": self.error,
        }


class Recognizer(Protocol):
    model_name: str
    device: str
    compute_type: str
    status: ModelStatus
    error: str | None

    async def load(self) -> None: ...

    async def transcribe(
        self,
        audio: FloatAudio,
        *,
        partial: bool,
        beam_size: int | None = None,
    ) -> RecognitionResult: ...


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
        self.runtime_profile = settings.runtime_profile
        self.cuda_capabilities = settings.cuda_capabilities
        self.status = ModelStatus.IDLE
        self.error: str | None = None
        self.warmup = WarmupInfo(completed=False, duration_ms=None)
        self._model: object | None = None
        self._load_lock = asyncio.Lock()
        self._decode_lock = asyncio.Lock()

    @property
    def runtime_metadata(self) -> dict[str, object]:
        """Read-only model/profile facts suitable for health output."""
        metadata: dict[str, object] = {
            "model": self.model_name,
            "device": self.device,
            "computeType": self.compute_type,
            "profile": self.runtime_profile.as_dict(),
            "warmup": self.warmup.as_dict(),
        }
        if self.cuda_capabilities is not None:
            metadata["cuda"] = self.cuda_capabilities.as_dict()
        return metadata

    @property
    def warmup_completed(self) -> bool:
        return self.warmup.completed

    @property
    def warmup_ms(self) -> int | None:
        return self.warmup.duration_ms

    async def load(self) -> None:
        async with self._load_lock:
            if self.status is ModelStatus.READY:
                return
            self.status = ModelStatus.LOADING
            self.error = None
            self.warmup = WarmupInfo(completed=False, duration_ms=None)
            try:
                self._model = await asyncio.to_thread(self._load_sync)
                started = time.perf_counter()
                await asyncio.to_thread(self._warmup_sync)
                self.warmup = WarmupInfo(
                    completed=True,
                    duration_ms=round((time.perf_counter() - started) * 1_000),
                )
            except Exception as exc:
                self.warmup = WarmupInfo(
                    completed=False,
                    duration_ms=None,
                    error=f"{type(exc).__name__}: {exc}",
                )
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

    def _warmup_sync(self) -> None:
        """Run one discarded inference so readiness includes CUDA allocation.

        The warmup never enters ``transcribe`` or a session queue, so it cannot
        increment utterance counters, emit a transcript, or be mistaken for
        user speech. It uses the same model instance and decode options as a
        partial, only with a short zero-valued PCM buffer.
        """
        import numpy as np

        if self._model is None:
            raise RuntimeError("The recognition model is not ready for warmup.")
        audio = np.zeros(1_600, dtype=np.float32)
        self._decode_model(audio, partial=True)

    async def transcribe(
        self,
        audio: FloatAudio,
        *,
        partial: bool,
        beam_size: int | None = None,
    ) -> RecognitionResult:
        if self.status is not ModelStatus.READY or self._model is None:
            raise RuntimeError("The recognition model is not ready.")
        if beam_size is not None and beam_size < 1:
            raise ValueError("beam_size must be at least 1.")
        async with self._decode_lock:
            return await asyncio.to_thread(self._transcribe_sync, audio, partial, beam_size)

    def decoder_options(
        self,
        *,
        partial: bool,
        beam_size: int | None = None,
    ) -> dict[str, object]:
        """Return explicit faster-whisper options for reproducible beam sweeps.

        The production path uses ``settings.beam_size``.  A caller may provide a
        positive temporary beam without mutating the recognizer, which lets an
        evaluation sweep compare decoder choices against the same loaded model.
        """
        selected_beam = self.beam_size if beam_size is None else beam_size
        if selected_beam < 1:
            raise ValueError("beam_size must be at least 1.")
        return {
            "language": self.language,
            "beam_size": selected_beam,
            "best_of": selected_beam,
            "condition_on_previous_text": False,
            "initial_prompt": (
                (self.prompt_override or dental_prompt()) if self.bias_prompt else None
            ),
            "word_timestamps": self.word_timestamps and not partial,
            "vad_filter": False,
            "without_timestamps": partial or not self.word_timestamps,
        }

    def _decode_model(
        self,
        audio: FloatAudio,
        *,
        partial: bool,
        beam_size: int | None = None,
    ) -> None:
        """Materialize one model decode and discard all warmup output."""
        model = self._model
        if model is None:
            raise RuntimeError("The recognition model is not ready.")
        segments, _ = model.transcribe(  # type: ignore[attr-defined]
            audio,
            **self.decoder_options(partial=partial, beam_size=beam_size),
        )
        # faster-whisper is lazy: calling ``transcribe`` alone does not execute
        # the decoder or allocate the CUDA workspaces.
        list(segments)

    def _transcribe_sync(
        self,
        audio: FloatAudio,
        partial: bool,
        beam_size: int | None = None,
    ) -> RecognitionResult:
        started = time.perf_counter()
        model = self._model
        if model is None:
            raise RuntimeError("The recognition model is not ready.")
        segments, _ = model.transcribe(  # type: ignore[attr-defined]
            audio,
            **self.decoder_options(partial=partial, beam_size=beam_size),
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
