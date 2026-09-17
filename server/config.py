from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def _env_float(name: str, default: float) -> float:
    return float(os.getenv(name, str(default)))


@dataclass(frozen=True, slots=True)
class Settings:
    model_name: str = "tiny.en"
    model_dir: Path = Path("models")
    device: str = "cpu"
    compute_type: str = "int8"
    language: str = "en"
    sample_rate: int = 16_000
    vad_rms_threshold: float = 0.012
    pre_roll_ms: int = 200
    min_speech_ms: int = 180
    end_silence_ms: int = 520
    partial_interval_ms: int = 700
    max_utterance_ms: int = 12_000
    decode_queue_size: int = 2
    allowed_origins: tuple[str, ...] = (
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    )

    def __post_init__(self) -> None:
        if self.sample_rate != 16_000:
            raise ValueError("ASR_SAMPLE_RATE must be 16000 to match protocol v1.")
        if not 0 < self.vad_rms_threshold < 1:
            raise ValueError("ASR_VAD_RMS_THRESHOLD must be between 0 and 1.")
        if self.pre_roll_ms < 0:
            raise ValueError("ASR_PRE_ROLL_MS cannot be negative.")
        if min(self.min_speech_ms, self.end_silence_ms, self.partial_interval_ms) <= 0:
            raise ValueError("ASR timing values must be positive.")
        if self.max_utterance_ms < self.min_speech_ms:
            raise ValueError("ASR_MAX_UTTERANCE_MS must be at least ASR_MIN_SPEECH_MS.")
        if self.decode_queue_size < 1:
            raise ValueError("ASR_DECODE_QUEUE_SIZE must be at least 1.")

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            model_name=os.getenv("ASR_MODEL", "tiny.en"),
            model_dir=Path(os.getenv("ASR_MODEL_DIR", "models")),
            device=os.getenv("ASR_DEVICE", "cpu"),
            compute_type=os.getenv("ASR_COMPUTE_TYPE", "int8"),
            language=os.getenv("ASR_LANGUAGE", "en"),
            sample_rate=_env_int("ASR_SAMPLE_RATE", 16_000),
            vad_rms_threshold=_env_float("ASR_VAD_RMS_THRESHOLD", 0.012),
            pre_roll_ms=_env_int("ASR_PRE_ROLL_MS", 200),
            min_speech_ms=_env_int("ASR_MIN_SPEECH_MS", 180),
            end_silence_ms=_env_int("ASR_END_SILENCE_MS", 520),
            partial_interval_ms=_env_int("ASR_PARTIAL_INTERVAL_MS", 700),
            max_utterance_ms=_env_int("ASR_MAX_UTTERANCE_MS", 12_000),
            decode_queue_size=_env_int("ASR_DECODE_QUEUE_SIZE", 2),
            allowed_origins=tuple(
                origin.strip()
                for origin in os.getenv(
                    "ASR_ALLOWED_ORIGINS",
                    "http://127.0.0.1:5173,http://localhost:5173",
                ).split(",")
                if origin.strip()
            ),
        )
