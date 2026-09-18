from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from server.app import create_app
from server.auth import AuthStore
from server.config import Settings
from tests.server.fakes import FakeRecognizer


def voiced_pcm(seconds: float, frequency: float = 140.0) -> bytes:
    samples = np.arange(int(16_000 * seconds))
    tone = np.zeros_like(samples, dtype=np.float64)
    for harmonic in range(1, 12):
        tone += np.sin(2 * np.pi * frequency * harmonic * samples / 16_000) / harmonic
    tone = tone / np.max(np.abs(tone)) * 0.5
    return (tone * 32_767).astype("<i2").tobytes()


def build(path: Path) -> tuple[object, AuthStore]:
    store = AuthStore(path, password_iterations=1_000)
    app = create_app(FakeRecognizer(), Settings(), preload=False, auth_store=store)
    return app, store


def register(client: TestClient, name: str, email: str) -> None:
    response = client.post(
        "/api/auth/register",
        json={"name": name, "email": email, "password": "charting-safe-42"},
    )
    assert response.status_code == 201


def test_enrollment_is_scoped_to_the_signed_in_hygienist(tmp_path: Path) -> None:
    app, store = build(tmp_path / "accounts.sqlite3")
    with TestClient(app) as client:
        register(client, "Maya Patel", "maya@example.com")
        assert client.post("/api/speaker/enroll", content=voiced_pcm(3)).json()["enrolled"]
        client.post("/api/auth/logout")

        register(client, "Jordan Lee", "jordan@example.com")
        assert client.get("/api/speaker").json()["enrolled"] is False
        client.post("/api/auth/logout")

        client.post(
            "/api/auth/login",
            json={"email": "maya@example.com", "password": "charting-safe-42"},
        )
        assert client.get("/api/speaker").json()["enrolled"] is True
    store.close()


def test_voice_profile_survives_an_application_restart(tmp_path: Path) -> None:
    database = tmp_path / "accounts.sqlite3"
    first_app, first_store = build(database)
    with TestClient(first_app) as client:
        register(client, "Maya Patel", "maya@example.com")
        assert client.post("/api/speaker/enroll", content=voiced_pcm(3)).status_code == 200
    first_store.close()

    second_app, second_store = build(database)
    with TestClient(second_app) as client:
        login = client.post(
            "/api/auth/login",
            json={"email": "maya@example.com", "password": "charting-safe-42"},
        )
        assert login.json()["account"]["voiceEnrolled"] is True
        state = client.get("/api/speaker").json()
        assert state["enrolled"] is True
        assert state["samples"] == 1
    second_store.close()


def test_revocation_deletes_only_the_current_accounts_profile(tmp_path: Path) -> None:
    app, store = build(tmp_path / "accounts.sqlite3")
    with TestClient(app) as client:
        register(client, "Maya Patel", "maya@example.com")
        client.post("/api/speaker/enroll", content=voiced_pcm(3, 140))
        client.post("/api/auth/logout")
        register(client, "Jordan Lee", "jordan@example.com")
        client.post("/api/speaker/enroll", content=voiced_pcm(3, 180))
        assert client.post("/api/speaker/reset").json()["enrolled"] is False
        client.post("/api/auth/logout")
        client.post(
            "/api/auth/login",
            json={"email": "maya@example.com", "password": "charting-safe-42"},
        )
        assert client.get("/api/speaker").json()["enrolled"] is True
    store.close()


def test_failed_enrollment_never_overwrites_a_saved_profile(tmp_path: Path) -> None:
    app, store = build(tmp_path / "accounts.sqlite3")
    with TestClient(app) as client:
        register(client, "Maya Patel", "maya@example.com")
        enrolled = client.post("/api/speaker/enroll", content=voiced_pcm(3)).json()
        failed = client.post("/api/speaker/enroll", content=b"\x00\x00" * 200)
        assert failed.status_code == 400
        state = client.get("/api/speaker").json()
        assert state["enrolled"] is True
        assert state["samples"] == enrolled["samples"]
    store.close()
