from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from server.speaker import SpeakerProfileSnapshot

SESSION_COOKIE = "perio_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
PASSWORD_ITERATIONS = 600_000
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class AuthError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Account:
    id: str
    name: str
    email: str
    created_at: int

    def as_message(self, *, voice_enrolled: bool) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "createdAt": self.created_at,
            "voiceEnrolled": voice_enrolled,
        }


def _normalize_email(value: str) -> str:
    email = value.strip().casefold()
    if len(email) > 254 or EMAIL_PATTERN.fullmatch(email) is None:
        raise AuthError("Enter a valid email address.")
    return email


def _normalize_name(value: str) -> str:
    name = " ".join(value.strip().split())
    if not 2 <= len(name) <= 80:
        raise AuthError("Name must be between 2 and 80 characters.")
    return name


def _validate_password(value: str) -> None:
    if len(value) < 12:
        raise AuthError("Password must be at least 12 characters.")
    if len(value) > 256:
        raise AuthError("Password is too long.")
    if not any(character.isalpha() for character in value) or not any(
        character.isdigit() for character in value
    ):
        raise AuthError("Password must include at least one letter and one number.")


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class AuthStore:
    """Small local identity store with opaque, revocable browser sessions."""

    def __init__(self, path: Path | str, *, password_iterations: int = PASSWORD_ITERATIONS) -> None:
        self.path = path
        self.password_iterations = password_iterations
        self._lock = threading.RLock()
        if path != ":memory:":
            resolved = Path(path)
            resolved.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            resolved.parent.chmod(0o700)
        self._database = sqlite3.connect(path, check_same_thread=False)
        self._database.row_factory = sqlite3.Row
        self._database.execute("PRAGMA foreign_keys = ON")
        if path != ":memory:":
            self._database.execute("PRAGMA journal_mode = WAL")
        self._migrate()

    @classmethod
    def from_env(cls) -> AuthStore:
        data_dir = Path(os.getenv("PERIO_DATA_DIR", "data"))
        return cls(data_dir / "perio-voice.sqlite3")

    def _migrate(self) -> None:
        with self._lock, self._database:
            self._database.executescript(
                """
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    password_hash BLOB NOT NULL,
                    password_salt BLOB NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_account_id ON sessions(account_id);
                CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
                CREATE TABLE IF NOT EXISTS voice_profiles (
                    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                    spectral BLOB NOT NULL,
                    spectral_size INTEGER NOT NULL,
                    cepstral BLOB NOT NULL,
                    cepstral_size INTEGER NOT NULL,
                    samples INTEGER NOT NULL,
                    voiced_ms INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                """
            )

    def close(self) -> None:
        with self._lock:
            self._database.close()

    def create_account(self, name: str, email: str, password: str) -> Account:
        clean_name = _normalize_name(name)
        clean_email = _normalize_email(email)
        _validate_password(password)
        salt = secrets.token_bytes(16)
        password_hash = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, self.password_iterations
        )
        now = int(time.time())
        account = Account(str(uuid.uuid4()), clean_name, clean_email, now)
        try:
            with self._lock, self._database:
                self._database.execute(
                    """
                    INSERT INTO accounts(id, name, email, password_hash, password_salt, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (account.id, account.name, account.email, password_hash, salt, now),
                )
        except sqlite3.IntegrityError as error:
            raise AuthError("An account with this email already exists.") from error
        return account

    def authenticate(self, email: str, password: str) -> Account | None:
        try:
            clean_email = _normalize_email(email)
        except AuthError:
            clean_email = ""
        with self._lock:
            row = self._database.execute(
                "SELECT * FROM accounts WHERE email = ?", (clean_email,)
            ).fetchone()
        salt = bytes(row["password_salt"]) if row is not None else bytes(16)
        expected = bytes(row["password_hash"]) if row is not None else bytes(32)
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, self.password_iterations
        )
        if row is None or not hmac.compare_digest(candidate, expected):
            return None
        return self._account(row)

    def create_session(self, account_id: str) -> str:
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self._lock, self._database:
            self._database.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            self._database.execute(
                """
                INSERT INTO sessions(token_hash, account_id, created_at, expires_at)
                VALUES (?, ?, ?, ?)
                """,
                (_token_hash(token), account_id, now, now + SESSION_TTL_SECONDS),
            )
        return token

    def account_for_session(self, token: str | None) -> Account | None:
        if not token:
            return None
        now = int(time.time())
        with self._lock, self._database:
            self._database.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            row = self._database.execute(
                """
                SELECT accounts.* FROM sessions
                JOIN accounts ON accounts.id = sessions.account_id
                WHERE sessions.token_hash = ? AND sessions.expires_at > ?
                """,
                (_token_hash(token), now),
            ).fetchone()
        return self._account(row) if row is not None else None

    def revoke_session(self, token: str | None) -> None:
        if not token:
            return
        with self._lock, self._database:
            self._database.execute(
                "DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),)
            )

    def load_voice_profile(self, account_id: str) -> SpeakerProfileSnapshot | None:
        with self._lock:
            row = self._database.execute(
                "SELECT * FROM voice_profiles WHERE account_id = ?", (account_id,)
            ).fetchone()
        if row is None:
            return None
        return SpeakerProfileSnapshot.from_bytes(
            spectral=bytes(row["spectral"]),
            spectral_size=int(row["spectral_size"]),
            cepstral=bytes(row["cepstral"]),
            cepstral_size=int(row["cepstral_size"]),
            samples=int(row["samples"]),
            voiced_ms=int(row["voiced_ms"]),
        )

    def save_voice_profile(self, account_id: str, profile: SpeakerProfileSnapshot) -> None:
        spectral, cepstral = profile.as_bytes()
        with self._lock, self._database:
            self._database.execute(
                """
                INSERT INTO voice_profiles(
                    account_id, spectral, spectral_size, cepstral, cepstral_size,
                    samples, voiced_ms, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(account_id) DO UPDATE SET
                    spectral = excluded.spectral,
                    spectral_size = excluded.spectral_size,
                    cepstral = excluded.cepstral,
                    cepstral_size = excluded.cepstral_size,
                    samples = excluded.samples,
                    voiced_ms = excluded.voiced_ms,
                    updated_at = excluded.updated_at
                """,
                (
                    account_id,
                    spectral,
                    profile.spectral.size,
                    cepstral,
                    profile.cepstral.size,
                    profile.samples,
                    profile.voiced_ms,
                    int(time.time()),
                ),
            )

    def delete_voice_profile(self, account_id: str) -> None:
        with self._lock, self._database:
            self._database.execute(
                "DELETE FROM voice_profiles WHERE account_id = ?", (account_id,)
            )

    def voice_enrolled(self, account_id: str, required_ms: int) -> bool:
        with self._lock:
            row = self._database.execute(
                "SELECT voiced_ms FROM voice_profiles WHERE account_id = ?", (account_id,)
            ).fetchone()
        return row is not None and int(row["voiced_ms"]) >= required_ms

    @staticmethod
    def _account(row: sqlite3.Row) -> Account:
        return Account(
            id=str(row["id"]),
            name=str(row["name"]),
            email=str(row["email"]),
            created_at=int(row["created_at"]),
        )
