from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.app import create_app
from server.auth import AuthStore
from server.config import Settings
from tests.server.fakes import FakeRecognizer


def auth_app(path: Path) -> tuple[object, AuthStore]:
    store = AuthStore(path, password_iterations=1_000)
    app = create_app(FakeRecognizer(), Settings(), preload=False, auth_store=store)
    return app, store


def register(client: TestClient, *, email: str = "maya@example.com") -> dict[str, object]:
    response = client.post(
        "/api/auth/register",
        json={"name": "Maya Patel", "email": email, "password": "charting-safe-42"},
    )
    assert response.status_code == 201
    return response.json()["account"]  # type: ignore[no-any-return]


def test_protected_clinical_endpoints_require_authentication(tmp_path: Path) -> None:
    app, store = auth_app(tmp_path / "auth.sqlite3")
    with TestClient(app) as client:
        assert client.get("/api/speaker").status_code == 401
        assert client.post("/api/speaker/reset").status_code == 401
        assert client.get("/api/metrics").status_code == 401
        assert client.get("/api/health").status_code == 200
    store.close()


def test_websocket_rejects_an_anonymous_browser(tmp_path: Path) -> None:
    app, store = auth_app(tmp_path / "auth.sqlite3")
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as rejected:
            with client.websocket_connect("/ws/asr"):
                pass
    assert rejected.value.code == 4401
    store.close()


def test_registration_normalizes_identity_and_starts_a_session(tmp_path: Path) -> None:
    app, store = auth_app(tmp_path / "auth.sqlite3")
    with TestClient(app) as client:
        response = client.post(
            "/api/auth/register",
            json={
                "name": "  Maya   Patel ",
                "email": " MAYA@EXAMPLE.COM ",
                "password": "charting-safe-42",
            },
        )
        assert response.status_code == 201
        assert response.json()["account"]["name"] == "Maya Patel"
        assert response.json()["account"]["email"] == "maya@example.com"
        assert response.json()["account"]["voiceEnrolled"] is False
        cookie = response.headers["set-cookie"]
        assert "HttpOnly" in cookie
        assert "SameSite=strict" in cookie
        assert client.get("/api/auth/me").json()["account"]["email"] == "maya@example.com"
    store.close()


def test_duplicate_email_is_rejected_without_replacing_the_session(tmp_path: Path) -> None:
    app, store = auth_app(tmp_path / "auth.sqlite3")
    with TestClient(app) as client:
        account = register(client)
        duplicate = client.post(
            "/api/auth/register",
            json={
                "name": "Someone Else",
                "email": "MAYA@example.com",
                "password": "another-secure-88",
            },
        )
        assert duplicate.status_code == 400
        assert "already exists" in duplicate.json()["detail"]
        assert client.get("/api/auth/me").json()["account"]["id"] == account["id"]
    store.close()


@pytest.mark.parametrize(
    "password",
    ["short1", "long-without-a-number", "123456789012345"],
)
def test_registration_rejects_weak_passwords(tmp_path: Path, password: str) -> None:
    app, store = auth_app(tmp_path / f"{len(password)}.sqlite3")
    with TestClient(app) as client:
        response = client.post(
            "/api/auth/register",
            json={"name": "Maya Patel", "email": "maya@example.com", "password": password},
        )
        assert response.status_code == 400
        assert "password" in response.json()["detail"].lower()
    store.close()


def test_login_uses_a_generic_failure_and_restores_a_valid_session(tmp_path: Path) -> None:
    app, store = auth_app(tmp_path / "auth.sqlite3")
    with TestClient(app) as client:
        register(client)
        client.post("/api/auth/logout")
        invalid = client.post(
            "/api/auth/login",
            json={"email": "nobody@example.com", "password": "incorrect-pass-88"},
        )
        assert invalid.status_code == 401
        assert invalid.json()["detail"] == "Email or password is incorrect."
        valid = client.post(
            "/api/auth/login",
            json={"email": "MAYA@example.com", "password": "charting-safe-42"},
        )
        assert valid.status_code == 200
        assert client.get("/api/auth/me").status_code == 200
    store.close()


def test_logout_revokes_the_server_side_session(tmp_path: Path) -> None:
    app, store = auth_app(tmp_path / "auth.sqlite3")
    with TestClient(app) as client:
        register(client)
        token = client.cookies.get("perio_session")
        assert token
        assert client.post("/api/auth/logout").status_code == 204
        assert client.get("/api/auth/me").status_code == 401
        assert store.account_for_session(token) is None
    store.close()


def test_mutating_auth_requests_reject_untrusted_origins(tmp_path: Path) -> None:
    app, store = auth_app(tmp_path / "auth.sqlite3")
    with TestClient(app) as client:
        response = client.post(
            "/api/auth/register",
            headers={"origin": "https://malicious.example"},
            json={
                "name": "Maya Patel",
                "email": "maya@example.com",
                "password": "charting-safe-42",
            },
        )
        assert response.status_code == 403
    store.close()
