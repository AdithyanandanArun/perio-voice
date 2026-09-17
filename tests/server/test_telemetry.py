"""Telemetry has to be useful operationally and carry nothing clinical."""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.config import Settings
from server.telemetry import COUNTERS, HISTOGRAMS, RESERVOIR, Telemetry
from tests.server.fakes import FakeRecognizer


def pcm_frame(level: float, milliseconds: int = 100) -> bytes:
    return np.full(16 * milliseconds, round(level * 32_767), dtype="<i2").tobytes()


def test_metric_names_are_a_fixed_allowlist() -> None:
    telemetry = Telemetry()
    with pytest.raises(KeyError, match="Unknown telemetry counter"):
        telemetry.count("tooth_14_bleeding")
    with pytest.raises(KeyError, match="Unknown telemetry histogram"):
        telemetry.observe("transcript_length_for_patient", 1.0)


def test_a_snapshot_exposes_every_declared_series() -> None:
    snapshot = Telemetry().snapshot()
    assert set(snapshot["counters"]) == set(COUNTERS)  # type: ignore[arg-type]
    assert set(snapshot["histograms"]) == set(HISTOGRAMS)  # type: ignore[arg-type]


def test_a_snapshot_contains_only_numbers_under_known_names() -> None:
    telemetry = Telemetry()
    telemetry.count("finals_total", 3)
    telemetry.observe("decode_ms_final", 120.0)
    snapshot = telemetry.snapshot()

    for name, value in snapshot["counters"].items():  # type: ignore[union-attr]
        assert name in COUNTERS
        assert isinstance(value, int)
    for name, summary in snapshot["histograms"].items():  # type: ignore[union-attr]
        assert name in HISTOGRAMS
        for key, value in summary.items():
            assert key in {"count", "mean", "p50", "p95", "p99", "max"}
            assert value is None or isinstance(value, int | float)


def test_histograms_summarize_the_tail_operators_care_about() -> None:
    telemetry = Telemetry()
    for value in range(1, 101):
        telemetry.observe("decode_ms_final", float(value))
    summary = telemetry.snapshot()["histograms"]["decode_ms_final"]  # type: ignore[index]
    assert summary["count"] == 100
    assert summary["p50"] == pytest.approx(50, abs=1)
    assert summary["p95"] == pytest.approx(95, abs=1)
    assert summary["max"] == 100


def test_histogram_memory_is_bounded_by_the_reservoir() -> None:
    telemetry = Telemetry()
    for value in range(RESERVOIR * 3):
        telemetry.observe("audio_ms", float(value))
    summary = telemetry.snapshot()["histograms"]["audio_ms"]  # type: ignore[index]
    assert summary["count"] == RESERVOIR * 3
    assert summary["max"] == RESERVOIR * 3 - 1


def test_the_running_service_reports_counters_over_the_health_surface() -> None:
    settings = Settings(vad_rms_threshold=0.01, pre_roll_ms=0, min_speech_ms=50, end_silence_ms=200)
    app = create_app(FakeRecognizer(), settings)
    with TestClient(app) as client:
        with client.websocket_connect("/ws/asr") as socket:
            socket.receive_json()
            socket.receive_json()
            socket.send_json({"type": "start"})
            socket.send_bytes(pcm_frame(0.2))
            socket.send_bytes(pcm_frame(0))
            socket.send_json({"type": "stop"})
            for _ in range(8):
                if socket.receive_json()["type"] == "stopped":
                    break

        metrics = client.get("/api/metrics").json()
        assert metrics["counters"]["connections_total"] == 1
        assert metrics["counters"]["streams_started"] == 1
        assert metrics["counters"]["utterances_total"] >= 1
        assert metrics["histograms"]["decode_ms_final"]["count"] >= 1

        body = client.get("/api/metrics").text
        assert "three four five" not in body
        assert "transcript" not in body.lower()
