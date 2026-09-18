from __future__ import annotations

import asyncio
import json

import pytest

from server.config import (
    CPU_RUNTIME_PROFILE,
    CUDA_4GB_RUNTIME_PROFILE,
    Settings,
    service_settings,
)
from server.cuda_runtime import CudaCapabilities
from server.grammar_recognizer import VoskGrammarSession
from server.recognizer import FasterWhisperRecognizer, ModelStatus, WarmupInfo
from server.routed_recognizer import RoutedRecognizer
from server.routing import Engine
from tests.server.fakes import FakeRecognizer

ASR_VARIABLES = (
    "ASR_DEVICE",
    "ASR_MODEL",
    "ASR_COMPUTE_TYPE",
    "ASR_ENGINE",
    "ASR_WORD_TIMESTAMPS",
    "ASR_SPEECH_PRESENCE_THRESHOLD",
    "ASR_NO_SPEECH_THRESHOLD",
)


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ASR_VARIABLES:
        monkeypatch.delenv(name, raising=False)


def gpu(
    monkeypatch: pytest.MonkeyPatch,
    present: bool,
    *,
    memory_mib: int | None = 4_096,
    compute_capability: str | None = "8.6",
) -> None:
    import server.cuda_runtime

    monkeypatch.setattr(server.cuda_runtime, "cuda_available", lambda: present)
    monkeypatch.setattr(
        server.cuda_runtime,
        "cuda_capabilities",
        lambda: CudaCapabilities(
            available=present,
            device_count=1 if present else 0,
            device_name="test-gpu" if present else None,
            memory_mib=memory_mib if present else None,
            compute_capability=compute_capability if present else None,
            runtime_libraries=("libcublas.so.12", "libcudnn.so.9") if present else (),
        ),
    )


def test_service_uses_the_measured_gpu_profile_when_a_gpu_is_usable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gpu(monkeypatch, True)
    settings = service_settings()
    assert settings.device == "cuda"
    assert settings.model_name == "large-v3"
    assert settings.compute_type == "int8_float16"
    assert settings.engine is Engine.WHISPER
    assert settings.word_timestamps is False
    # The prompted model recites clinical text on noise, so the GPU profile must
    # never run without the independent speech check.
    assert settings.speech_presence_threshold == 0.35
    assert settings.no_speech_threshold == 0.15
    assert settings.profile is CUDA_4GB_RUNTIME_PROFILE
    assert settings.profile.minimum_vram_mib == 4_096
    assert settings.profile.estimated_vram_mib == 3_200
    assert settings.profile.compute_capability is None
    assert settings.cuda_capabilities is not None
    assert settings.cuda_capabilities.memory_mib == 4_096
    assert settings.cuda_capabilities.compute_capability == "8.6"
    assert settings.capability_metadata["profile"] == settings.profile.as_dict()
    assert settings.capability_metadata["cuda"] == settings.cuda_capabilities.as_dict()


def test_service_falls_back_to_the_cpu_defaults_without_a_gpu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gpu(monkeypatch, False)
    settings = service_settings()
    assert (settings.device, settings.model_name, settings.engine) == (
        "cpu",
        "tiny.en",
        Engine.AUTO,
    )
    assert settings.word_timestamps is True
    # Model-independent speech checks apply on the CPU too; the no-speech
    # threshold keeps the value measured for tiny.en.
    assert settings.speech_presence_threshold == 0.35
    assert settings.no_speech_threshold == 0.6


def test_explicit_variables_win_over_the_gpu_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    gpu(monkeypatch, True)
    monkeypatch.setenv("ASR_MODEL", "large-v3-turbo")
    monkeypatch.setenv("ASR_COMPUTE_TYPE", "float16")
    monkeypatch.setenv("ASR_ENGINE", "auto")
    monkeypatch.setenv("ASR_WORD_TIMESTAMPS", "1")
    monkeypatch.setenv("ASR_NO_SPEECH_THRESHOLD", "0.61")
    settings = service_settings()
    assert settings.device == "cuda"
    assert settings.model_name == "large-v3-turbo"
    assert settings.compute_type == "float16"
    assert settings.engine is Engine.AUTO
    assert settings.word_timestamps is True
    assert settings.no_speech_threshold == 0.61


def test_an_explicit_cpu_request_ignores_the_gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    gpu(monkeypatch, True)
    monkeypatch.setenv("ASR_DEVICE", "cpu")
    settings = service_settings()
    assert (settings.device, settings.model_name) == ("cpu", "tiny.en")


def test_auto_mode_uses_cpu_when_cuda_vram_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    gpu(monkeypatch, True, memory_mib=None)
    settings = service_settings()
    assert (settings.device, settings.model_name) == ("cpu", "tiny.en")
    assert settings.profile is CPU_RUNTIME_PROFILE
    assert settings.cuda_capabilities is not None
    assert settings.cuda_capabilities.profile_name == "cuda-unknown-vram"


def test_explicit_cuda_can_override_unknown_vram(monkeypatch: pytest.MonkeyPatch) -> None:
    gpu(monkeypatch, True, memory_mib=None)
    monkeypatch.setenv("ASR_DEVICE", "cuda")
    settings = service_settings()
    assert settings.device == "cuda"
    assert settings.profile is CUDA_4GB_RUNTIME_PROFILE
    assert settings.model_name == "large-v3"
    assert settings.cuda_capabilities is not None
    assert settings.cuda_capabilities.memory_mib is None


def test_scripts_keep_deterministic_cpu_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gates call Settings.from_env(); a GPU on the machine must not change them."""
    gpu(monkeypatch, True)
    settings = Settings.from_env()
    assert (settings.device, settings.model_name, settings.engine) == (
        "cpu",
        "tiny.en",
        Engine.AUTO,
    )


class _FakeSegment:
    text = ""
    words: tuple[object, ...] = ()
    no_speech_prob = 1.0


class _FakeWhisperModel:
    def __init__(self, recognizer: FasterWhisperRecognizer) -> None:
        self.recognizer = recognizer
        self.calls: list[dict[str, object]] = []

    def transcribe(self, audio: object, **options: object) -> tuple[list[_FakeSegment], None]:
        assert self.recognizer.status is ModelStatus.LOADING
        self.calls.append(options)
        return [_FakeSegment()], None


def test_warmup_runs_before_ready_and_is_separate_from_user_transcribe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recognizer = FasterWhisperRecognizer(Settings())
    model = _FakeWhisperModel(recognizer)
    monkeypatch.setattr(recognizer, "_load_sync", lambda: model)

    asyncio.run(recognizer.load())

    assert recognizer.status is ModelStatus.READY
    assert recognizer.warmup.completed is True
    assert recognizer.warmup.duration_ms is not None
    assert len(model.calls) == 1
    assert model.calls[0]["without_timestamps"] is True
    assert recognizer.decoder_options(partial=False, beam_size=1)["beam_size"] == 1
    assert recognizer.beam_size == Settings().beam_size


def test_routed_runtime_metadata_is_json_safe_for_warmup() -> None:
    fake = FakeRecognizer()
    fake.warmup = WarmupInfo(completed=True, duration_ms=17)
    routed = RoutedRecognizer(Settings(engine=Engine.WHISPER), whisper=fake)

    metadata = routed.runtime_metadata

    assert metadata["warmup"] == {"completed": True, "durationMs": 17, "error": None}
    json.dumps(metadata)

    mixed = RoutedRecognizer(Settings(engine=Engine.AUTO), whisper=fake)
    mixed_metadata = mixed.runtime_metadata
    assert mixed_metadata["warmup"] == [None, {"completed": True, "durationMs": 17, "error": None}]
    json.dumps(mixed_metadata)


class _FakeIncrementalRecognizer:
    def __init__(self) -> None:
        self.accepted = 0
        self.results = (
            {
                "text": "three",
                "result": [{"word": "three", "start": 0.0, "end": 0.2, "conf": 0.9}],
            },
            {
                "text": "four",
                "result": [{"word": "four", "start": 0.2, "end": 0.4, "conf": 0.9}],
            },
        )

    def AcceptWaveform(self, pcm: bytes) -> bool:
        self.accepted += 1
        return self.accepted <= len(self.results)

    def Result(self) -> str:
        return json.dumps(self.results[self.accepted - 1])

    def PartialResult(self) -> str:
        return json.dumps({"partial": "five"})

    def FinalResult(self) -> str:
        return json.dumps(
            {
                "text": "five",
                "result": [{"word": "five", "start": 0.4, "end": 0.6, "conf": 0.9}],
            }
        )


def test_incremental_session_accumulates_multiple_completed_segments() -> None:
    session = VoskGrammarSession(
        _FakeIncrementalRecognizer(),
        sample_rate=16_000,
        max_alternatives=1,
    )

    first = session.feed_pcm_sync(b"\x00\x00")
    second = session.feed_pcm_sync(b"\x00\x00")
    partial = session.feed_pcm_sync(b"\x00\x00")
    final = session.finalize_sync()

    assert first.text == "three"
    assert second.text == "three four"
    assert partial.text == "three four five"
    assert final.text == "three four five"
    assert [word.word for word in final.words] == ["three", "four", "five"]
