from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.app import create_app
from server.config import Settings
from tests.server.fakes import FailOnceRecognizer, FakeRecognizer, SlowLoadingRecognizer


def pcm_frame(level: float, milliseconds: int = 100) -> bytes:
    return np.full(16 * milliseconds, round(level * 32_767), dtype="<i2").tobytes()


def receive_until(socket: object, expected: str) -> dict[str, object]:
    for _ in range(8):
        message = socket.receive_json()  # type: ignore[attr-defined]
        if message["type"] == expected:
            return message
    raise AssertionError(f"Did not receive {expected}")


def test_health_and_binary_websocket_protocol() -> None:
    recognizer = FakeRecognizer()
    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=50,
        end_silence_ms=200,
        partial_interval_ms=100,
    )
    app = create_app(recognizer, settings)
    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ready"
        assert health.json()["model"] == "fake-clinical-en"

        with client.websocket_connect("/ws/asr") as socket:
            assert socket.receive_json()["type"] == "hello"
            assert socket.receive_json()["type"] == "model_ready"
            socket.send_bytes(pcm_frame(0.1))
            assert socket.receive_json()["code"] == "stream_not_started"

            socket.send_json({"type": "start"})
            assert socket.receive_json()["type"] == "listening"
            socket.send_bytes(pcm_frame(0.2))
            assert socket.receive_json()["type"] == "speech_start"
            socket.send_bytes(pcm_frame(0.2))
            partial = receive_until(socket, "partial")
            assert partial["text"] == "three four"
            socket.send_bytes(pcm_frame(0))
            socket.send_bytes(pcm_frame(0))
            final = receive_until(socket, "final")
            assert final["text"] == "three four five"
            assert final["words"]

            socket.send_json({"type": "stop"})
            assert receive_until(socket, "stopped")["type"] == "stopped"


def test_invalid_audio_and_messages_are_recoverable() -> None:
    recognizer = FakeRecognizer()
    app = create_app(recognizer, Settings())
    with TestClient(app) as client, client.websocket_connect("/ws/asr") as socket:
        socket.receive_json()
        socket.receive_json()
        socket.send_json({"type": "start"})
        socket.receive_json()
        socket.send_bytes(b"\x01")
        invalid_audio = socket.receive_json()
        assert invalid_audio["code"] == "invalid_audio"
        assert invalid_audio["recoverable"] is True
        socket.send_json({"type": "unknown"})
        assert socket.receive_json()["code"] == "invalid_message"


def test_socket_remains_responsive_while_model_loads() -> None:
    recognizer = SlowLoadingRecognizer()
    app = create_app(recognizer, Settings())
    with TestClient(app) as client, client.websocket_connect("/ws/asr") as socket:
        assert socket.receive_json()["type"] == "hello"
        assert socket.receive_json()["type"] == "model_status"
        socket.send_json({"type": "ping"})
        assert socket.receive_json()["type"] == "pong"
        ready = receive_until(socket, "model_ready")
        assert ready["status"] == "ready"


def test_browser_websocket_rejects_an_untrusted_origin() -> None:
    app = create_app(FakeRecognizer(), Settings())
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as rejected:
            with client.websocket_connect(
                "/ws/asr", headers={"origin": "https://malicious.example"}
            ):
                pass
    assert rejected.value.code == 1008


def test_failed_model_load_can_be_retried_over_the_socket() -> None:
    recognizer = FailOnceRecognizer()
    app = create_app(recognizer, Settings())
    with TestClient(app) as client, client.websocket_connect("/ws/asr") as socket:
        assert socket.receive_json()["type"] == "hello"
        error_status: dict[str, object] | None = None
        for _ in range(4):
            candidate = socket.receive_json()
            if candidate.get("status") == "error":
                error_status = candidate
                break
        assert error_status is not None

        socket.send_json({"type": "retry_model"})
        ready = receive_until(socket, "model_ready")
        assert ready["status"] == "ready"
        assert recognizer.load_attempts == 2


def _voiced_pcm(seconds: float, frequency: float = 140.0) -> bytes:
    """A steady voiced-like signal, long enough to satisfy enrollment."""
    samples = np.arange(int(16_000 * seconds))
    tone = np.zeros_like(samples, dtype=np.float64)
    for harmonic in range(1, 12):
        tone += np.sin(2 * np.pi * frequency * harmonic * samples / 16_000) / harmonic
    tone = tone / np.max(np.abs(tone)) * 0.5
    return (tone * 32_767).astype("<i2").tobytes()


def test_health_reports_the_runtime_contract_the_browser_depends_on() -> None:
    app = create_app(FakeRecognizer(), Settings())
    with TestClient(app) as client:
        runtime = client.get("/api/health").json()["runtime"]
        assert runtime["protocol"] == 1
        assert runtime["denoiseProfile"] == "none"
        assert runtime["cadenceAdaptive"] is True
        assert runtime["endpointBandMs"][0] <= runtime["endSilenceMs"]
        assert runtime["endSilenceMs"] <= runtime["endpointBandMs"][1]
        assert runtime["promptVersion"]


def test_speaker_enrollment_is_explicit_and_revocable() -> None:
    app = create_app(FakeRecognizer(), Settings())
    with TestClient(app) as client:
        assert client.get("/api/speaker").json()["enrolled"] is False

        too_short = client.post("/api/speaker/enroll", content=_voiced_pcm(0.2))
        assert too_short.status_code == 400
        assert "at least" in too_short.json()["error"]
        assert client.get("/api/speaker").json()["enrolled"] is False

        enrolled = client.post("/api/speaker/enroll", content=_voiced_pcm(3.0))
        assert enrolled.status_code == 200
        assert enrolled.json()["enrolled"] is True
        assert enrolled.json()["samples"] == 1
        assert enrolled.json()["voicedMs"] >= 2_900

        state = client.get("/api/speaker").json()
        assert state["acceptThreshold"] > state["rejectThreshold"]

        assert client.post("/api/speaker/reset").json()["enrolled"] is False
        assert client.get("/api/speaker").json()["samples"] == 0


def test_malformed_enrollment_audio_is_reported_not_stored() -> None:
    app = create_app(FakeRecognizer(), Settings())
    with TestClient(app) as client:
        response = client.post("/api/speaker/enroll", content=b"\x01")
        assert response.status_code == 400
        assert client.get("/api/speaker").json()["enrolled"] is False


def test_finals_carry_attribution_only_once_a_clinician_is_enrolled() -> None:
    settings = Settings(vad_rms_threshold=0.01, pre_roll_ms=0, min_speech_ms=50, end_silence_ms=200)
    app = create_app(FakeRecognizer(), settings)
    with TestClient(app) as client:

        def run_utterance() -> dict[str, object]:
            with client.websocket_connect("/ws/asr") as socket:
                socket.receive_json()
                socket.receive_json()
                socket.send_json({"type": "start"})
                socket.send_bytes(pcm_frame(0.2))
                socket.send_bytes(pcm_frame(0))
                socket.send_json({"type": "stop"})
                return receive_until(socket, "final")

        assert run_utterance()["speaker"] is None

        client.post("/api/speaker/enroll", content=_voiced_pcm(3.0))
        speaker = run_utterance()["speaker"]
        assert isinstance(speaker, dict)
        assert speaker["enrolled"] is True
        assert speaker["decision"] in {"clinician", "other", "unknown"}
