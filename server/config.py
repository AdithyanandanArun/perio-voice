from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from server.denoise import DenoiseProfile, parse_profile
from server.routing import Engine, parse_engine


def _env_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def _env_float(name: str, default: float) -> float:
    return float(os.getenv(name, str(default)))


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


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
    speaker_accept: float = 0.96
    speaker_reject: float = 0.92
    speaker_min_ms: int = 150
    speaker_enroll_ms: int = 2_000
    """Trailing speech used for one attribution decision. Below roughly four
    seconds the spectral profile does not separate speakers at all."""
    speaker_window_ms: int = 4_000
    cadence_adaptive: bool = True
    min_end_silence_ms: int = 300
    max_end_silence_ms: int = 1_100
    cadence_window: int = 6
    denoise_profile: DenoiseProfile = DenoiseProfile.NONE
    bias_prompt: bool = True
    beam_size: int = 5
    engine: Engine = Engine.AUTO
    grammar_model_dir: Path = Path("models/vosk-model-en-us-0.22-lgraph")
    """Above this, Whisper's own no-speech estimate rejects the final outright."""
    no_speech_threshold: float = 0.6
    """Shorter finals are not decoded at all; every model hallucinates on them."""
    min_final_ms: int = 250
    """Competing readings returned per final, so clinical context can choose."""
    max_alternatives: int = 4
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
        if not -1.0 <= self.speaker_reject < self.speaker_accept <= 1.0:
            raise ValueError("ASR_SPEAKER_REJECT must be below ASR_SPEAKER_ACCEPT.")
        if self.speaker_min_ms <= 0:
            raise ValueError("ASR_SPEAKER_MIN_MS must be positive.")
        if self.speaker_enroll_ms < self.speaker_min_ms:
            raise ValueError("ASR_SPEAKER_ENROLL_MS must be at least ASR_SPEAKER_MIN_MS.")
        if not 0 < self.min_end_silence_ms <= self.max_end_silence_ms:
            raise ValueError("ASR_MIN_END_SILENCE_MS must be positive and below the maximum.")
        if self.cadence_window < 1:
            raise ValueError("ASR_CADENCE_WINDOW must be at least 1.")
        if self.beam_size < 1:
            raise ValueError("ASR_BEAM_SIZE must be at least 1.")
        if not 0.0 < self.no_speech_threshold <= 1.0:
            raise ValueError("ASR_NO_SPEECH_THRESHOLD must be between 0 and 1.")
        if self.min_final_ms < 0:
            raise ValueError("ASR_MIN_FINAL_MS cannot be negative.")
        if self.max_alternatives < 1:
            raise ValueError("ASR_MAX_ALTERNATIVES must be at least 1.")

    @property
    def endpoint_floor_ms(self) -> int:
        """The adaptive band always contains the configured starting point."""
        return min(self.min_end_silence_ms, self.end_silence_ms)

    @property
    def endpoint_ceiling_ms(self) -> int:
        return max(self.max_end_silence_ms, self.end_silence_ms)

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
            speaker_accept=_env_float("ASR_SPEAKER_ACCEPT", 0.96),
            speaker_reject=_env_float("ASR_SPEAKER_REJECT", 0.92),
            speaker_min_ms=_env_int("ASR_SPEAKER_MIN_MS", 150),
            speaker_enroll_ms=_env_int("ASR_SPEAKER_ENROLL_MS", 2_000),
            speaker_window_ms=_env_int("ASR_SPEAKER_WINDOW_MS", 4_000),
            cadence_adaptive=_env_bool("ASR_CADENCE_ADAPTIVE", True),
            min_end_silence_ms=_env_int("ASR_MIN_END_SILENCE_MS", 300),
            max_end_silence_ms=_env_int("ASR_MAX_END_SILENCE_MS", 1_100),
            cadence_window=_env_int("ASR_CADENCE_WINDOW", 6),
            denoise_profile=parse_profile(os.getenv("ASR_DENOISE_PROFILE", "none")),
            bias_prompt=_env_bool("ASR_BIAS_PROMPT", True),
            beam_size=_env_int("ASR_BEAM_SIZE", 5),
            engine=parse_engine(os.getenv("ASR_ENGINE", "auto")),
            grammar_model_dir=Path(
                os.getenv("ASR_GRAMMAR_MODEL_DIR", "models/vosk-model-en-us-0.22-lgraph")
            ),
            no_speech_threshold=_env_float("ASR_NO_SPEECH_THRESHOLD", 0.6),
            min_final_ms=_env_int("ASR_MIN_FINAL_MS", 250),
            max_alternatives=_env_int("ASR_MAX_ALTERNATIVES", 4),
            allowed_origins=tuple(
                origin.strip()
                for origin in os.getenv(
                    "ASR_ALLOWED_ORIGINS",
                    "http://127.0.0.1:5173,http://localhost:5173",
                ).split(",")
                if origin.strip()
            ),
        )
