from __future__ import annotations

import os
from dataclasses import dataclass, replace
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
    """Absolute floor, so a silent room cannot make the relative threshold
    collapse onto its own noise."""
    vad_rms_threshold: float = 0.004
    """Speech must exceed the tracked noise floor by this factor."""
    vad_margin: float = 3.0
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
    """Word timings on final decodes. They force timestamp tokens into the decode,
    which measured about 45 ms slower at the median and 110 ms at p95 with
    large-v3, for an optional relevance signal. Off on the GPU profile."""
    word_timestamps: bool = True
    """Segments whose highest Silero speech probability is below this are refused
    before decoding (server/speech_presence.py). 0 disables the check. On in the
    GPU profile, where the prompted model's no-speech estimate cannot be trusted."""
    speech_presence_threshold: float = 0.0
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
        if self.vad_margin < 1:
            raise ValueError("ASR_VAD_MARGIN must be at least 1.")
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
            vad_rms_threshold=_env_float("ASR_VAD_RMS_THRESHOLD", 0.004),
            vad_margin=_env_float("ASR_VAD_MARGIN", 3.0),
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
            word_timestamps=_env_bool("ASR_WORD_TIMESTAMPS", True),
            speech_presence_threshold=_env_float("ASR_SPEECH_PRESENCE_THRESHOLD", 0.0),
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


# Both measured on the replay recordings and 960 synthesized operatory bursts;
# see server/speech_presence.py. Silero keeps 136 of 138 speech segments at 0.35.
# The prompt pulls large-v3's no-speech estimate down on everything, so 0.6 (set
# for tiny.en) never fires: prompted speech scored at most 0.122 and every burst
# that passed Silero at least 0.174.
GPU_SPEECH_PRESENCE_THRESHOLD = 0.35
GPU_NO_SPEECH_THRESHOLD = 0.15


def service_settings() -> Settings:
    """Settings for the running service, upgraded to the GPU profile when usable.

    The GPU profile is the recognizer scripts/bakeoff.py chose on the replay
    recordings: large-v3 with the shared example prompt reached 94% chart
    accuracy at 330 ms median on an RTX 4060, against 54% for tiny.en and 55% for
    the grammar recognizer. Word timings are off because that measurement was
    made without them; they cost ~45 ms and feed an acoustic-confidence signal
    that was never calibrated against large-v3. Speech presence is judged by
    Silero VAD, because the prompt makes large-v3 recite clinical text on noise
    and suppresses its own no-speech estimate.

    Only the service does this. Scripts and tests that call Settings.from_env()
    keep the CPU defaults, so a gate behaves the same on a laptop with a GPU as
    in CI without one. Any ASR_* variable set explicitly always wins.
    """
    from server.cuda_runtime import cuda_available

    settings = Settings.from_env()

    def unset(name: str) -> bool:
        return os.getenv(name) is None

    # Saturation and Silero do not depend on the model or the prompt, and tiny.en
    # reads the same example prompt, so the CPU service gets them too.
    if unset("ASR_SPEECH_PRESENCE_THRESHOLD"):
        settings = replace(settings, speech_presence_threshold=GPU_SPEECH_PRESENCE_THRESHOLD)
    requested = os.getenv("ASR_DEVICE", "auto").strip().lower()
    if requested == "auto" and not cuda_available():
        return replace(settings, device="cpu")
    if requested not in {"auto", "cuda"}:
        return settings

    return replace(
        settings,
        device="cuda",
        model_name="large-v3" if unset("ASR_MODEL") else settings.model_name,
        # large-v3 in pure float16 exceeds the 4 GiB VRAM on the supported
        # laptop GPU. CTranslate2's int8_float16 keeps matmuls on the GPU,
        # fits the card, and remains overridable with ASR_COMPUTE_TYPE=float16
        # on a larger GPU.
        compute_type="int8_float16" if unset("ASR_COMPUTE_TYPE") else settings.compute_type,
        engine=Engine.WHISPER if unset("ASR_ENGINE") else settings.engine,
        word_timestamps=False if unset("ASR_WORD_TIMESTAMPS") else settings.word_timestamps,
        speech_presence_threshold=(
            GPU_SPEECH_PRESENCE_THRESHOLD
            if unset("ASR_SPEECH_PRESENCE_THRESHOLD")
            else settings.speech_presence_threshold
        ),
        no_speech_threshold=(
            GPU_NO_SPEECH_THRESHOLD
            if unset("ASR_NO_SPEECH_THRESHOLD")
            else settings.no_speech_threshold
        ),
    )
