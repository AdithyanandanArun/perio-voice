from __future__ import annotations

import pytest

from server.config import Settings, service_settings
from server.routing import Engine

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


def gpu(monkeypatch: pytest.MonkeyPatch, present: bool) -> None:
    import server.cuda_runtime

    monkeypatch.setattr(server.cuda_runtime, "cuda_available", lambda: present)


def test_service_uses_the_measured_gpu_profile_when_a_gpu_is_usable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gpu(monkeypatch, True)
    settings = service_settings()
    assert settings.device == "cuda"
    assert settings.model_name == "large-v3"
    assert settings.compute_type == "float16"
    assert settings.engine is Engine.WHISPER
    assert settings.word_timestamps is False
    # The prompted model recites clinical text on noise, so the GPU profile must
    # never run without the independent speech check.
    assert settings.speech_presence_threshold == 0.35
    assert settings.no_speech_threshold == 0.15


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
    assert settings.speech_presence_threshold == 0.0
    assert settings.no_speech_threshold == 0.6


def test_explicit_variables_win_over_the_gpu_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    gpu(monkeypatch, True)
    monkeypatch.setenv("ASR_MODEL", "large-v3-turbo")
    monkeypatch.setenv("ASR_WORD_TIMESTAMPS", "1")
    settings = service_settings()
    assert settings.device == "cuda"
    assert settings.model_name == "large-v3-turbo"
    assert settings.word_timestamps is True


def test_an_explicit_cpu_request_ignores_the_gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    gpu(monkeypatch, True)
    monkeypatch.setenv("ASR_DEVICE", "cpu")
    settings = service_settings()
    assert (settings.device, settings.model_name) == ("cpu", "tiny.en")


def test_scripts_keep_deterministic_cpu_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gates call Settings.from_env(); a GPU on the machine must not change them."""
    gpu(monkeypatch, True)
    settings = Settings.from_env()
    assert (settings.device, settings.model_name, settings.engine) == (
        "cpu",
        "tiny.en",
        Engine.AUTO,
    )
