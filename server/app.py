from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import tempfile
import time
import wave
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect

from server.audio import decode_pcm16
from server.config import Settings
from server.prompt import prompt_version
from server.recognizer import ModelStatus, Recognizer
from server.routed_recognizer import RoutedRecognizer
from server.session import AsrSession
from server.speaker import SpeakerGate
from server.telemetry import Telemetry
from server.vocabulary import parse_expectation

PROTOCOL_VERSION = 1
FIXTURE_MANIFEST_PATH = (
    Path(__file__).resolve().parents[1] / "evaluation" / "fixtures" / "dental" / "phrases.json"
)
FIXTURE_AUDIO_DIR = FIXTURE_MANIFEST_PATH.parent / "audio"
FIXTURE_PASSES = frozenset({"quiet", "noise"})
FIXTURE_SAMPLE_RATE = 16_000
MAX_FIXTURE_SECONDS = 30
MAX_FIXTURE_PCM_BYTES = FIXTURE_SAMPLE_RATE * 2 * MAX_FIXTURE_SECONDS
SAFE_FIXTURE_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")


def create_app(
    recognizer: Recognizer | None = None,
    settings: Settings | None = None,
    *,
    preload: bool = True,
) -> FastAPI:
    resolved_settings = settings or Settings.from_env()
    resolved_recognizer = recognizer or RoutedRecognizer(resolved_settings)
    telemetry = Telemetry()
    speaker_gate = SpeakerGate(resolved_settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.model_task = None
        if preload:
            app.state.model_task = asyncio.create_task(_load_model(resolved_recognizer, telemetry))
        yield
        task: asyncio.Task[None] | None = app.state.model_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = FastAPI(title="Perio Voice Local ASR", version="0.2.0", lifespan=lifespan)
    app.state.recognizer = resolved_recognizer
    app.state.settings = resolved_settings
    app.state.telemetry = telemetry
    app.state.speaker_gate = speaker_gate

    # Deliberately register no path operation unless the operator opts in before
    # starting the service. A disabled capture endpoint therefore returns the
    # framework's ordinary 404 rather than exposing a dormant upload surface.
    if os.getenv("PERIO_FIXTURE_CAPTURE") == "1":
        fixture_ids = _load_fixture_ids(FIXTURE_MANIFEST_PATH)

        @app.post("/api/fixture")
        async def capture_dental_fixture(
            request: Request,
            response: Response,
        ) -> dict[str, Any]:
            origin = request.headers.get("origin")
            if origin is not None and origin not in resolved_settings.allowed_origins:
                raise HTTPException(status_code=403, detail="Capture origin is not allowed.")
            pass_name = request.query_params.get("pass", "")
            utterance_id = request.query_params.get("id", "")
            if not pass_name or not utterance_id:
                raise HTTPException(
                    status_code=400, detail="Fixture pass and utterance id are required."
                )
            if pass_name not in FIXTURE_PASSES:
                raise HTTPException(status_code=404, detail="Unknown fixture pass.")
            if utterance_id not in fixture_ids:
                raise HTTPException(status_code=404, detail="Unknown fixture utterance id.")

            content_type = request.headers.get("content-type", "").split(";", 1)[0].strip()
            if content_type and content_type != "application/octet-stream":
                raise HTTPException(status_code=415, detail="Fixture capture requires raw PCM16.")
            content_length = request.headers.get("content-length")
            if content_length is not None:
                try:
                    declared_length = int(content_length)
                except ValueError as error:
                    raise HTTPException(
                        status_code=400, detail="Invalid Content-Length."
                    ) from error
                if declared_length < 0:
                    raise HTTPException(status_code=400, detail="Invalid Content-Length.")
                if declared_length > MAX_FIXTURE_PCM_BYTES:
                    raise HTTPException(status_code=413, detail="Fixture clip exceeds 30 seconds.")

            payload = bytearray()
            async for chunk in request.stream():
                if len(payload) + len(chunk) > MAX_FIXTURE_PCM_BYTES:
                    raise HTTPException(status_code=413, detail="Fixture clip exceeds 30 seconds.")
                payload.extend(chunk)
            pcm = bytes(payload)
            _validate_fixture_pcm(pcm)
            destination = FIXTURE_AUDIO_DIR / pass_name / f"{utterance_id}.wav"
            _write_fixture_wav(destination, pcm)
            response.headers["Cache-Control"] = "no-store"
            return {
                "id": utterance_id,
                "pass": pass_name,
                "samples": len(pcm) // 2,
                "durationMs": round((len(pcm) // 2) * 1_000 / FIXTURE_SAMPLE_RATE),
            }

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        message = _model_message(resolved_recognizer, resolved_settings)
        message["runtime"] = {
            "protocol": PROTOCOL_VERSION,
            "promptVersion": prompt_version(),
            "biasPrompt": resolved_settings.bias_prompt,
            "denoiseProfile": resolved_settings.denoise_profile.value,
            "endSilenceMs": resolved_settings.end_silence_ms,
            "endpointBandMs": [
                resolved_settings.endpoint_floor_ms,
                resolved_settings.endpoint_ceiling_ms,
            ],
            "cadenceAdaptive": resolved_settings.cadence_adaptive,
        }
        message["speaker"] = speaker_gate.state().as_message()
        return message

    @app.get("/api/metrics")
    async def metrics() -> dict[str, Any]:
        return telemetry.snapshot()

    @app.get("/api/speaker")
    async def speaker_state() -> dict[str, Any]:
        return {
            **speaker_gate.state().as_message(),
            "acceptThreshold": resolved_settings.speaker_accept,
            "rejectThreshold": resolved_settings.speaker_reject,
            "enrollMs": resolved_settings.speaker_enroll_ms,
        }

    @app.post("/api/speaker/enroll")
    async def enroll_speaker(request: Request, response: Response) -> dict[str, Any]:
        payload = await request.body()
        try:
            audio = decode_pcm16(payload)
            state = speaker_gate.enroll(audio)
        except ValueError as error:
            response.status_code = 400
            return {"error": str(error), **speaker_gate.state().as_message()}
        return state.as_message()

    @app.post("/api/speaker/reset")
    async def reset_speaker() -> dict[str, Any]:
        """Revokes the enrolled profile. Nothing about it was ever persisted."""
        return speaker_gate.reset().as_message()

    @app.websocket("/ws/asr")
    async def asr_socket(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        if origin is not None and origin not in resolved_settings.allowed_origins:
            await websocket.close(code=1008, reason="WebSocket origin is not allowed.")
            return
        await websocket.accept()
        telemetry.count("connections_total")
        send_lock = asyncio.Lock()

        async def send(message: dict[str, Any]) -> None:
            async with send_lock:
                await websocket.send_json(message)

        await send(
            {
                "type": "hello",
                "protocol": PROTOCOL_VERSION,
                "audio": {
                    "encoding": "pcm_s16le",
                    "sampleRate": resolved_settings.sample_rate,
                    "channels": 1,
                },
            }
        )
        await send(_model_message(resolved_recognizer, resolved_settings))
        model_task: asyncio.Task[None] | None = app.state.model_task
        model_notifier: asyncio.Task[None] | None = None

        def watch_model(task: asyncio.Task[None]) -> asyncio.Task[None]:
            async def notify_when_loaded() -> None:
                with contextlib.suppress(Exception):
                    await asyncio.shield(task)
                await send(_model_message(resolved_recognizer, resolved_settings))

            return asyncio.create_task(notify_when_loaded(), name="asr-model-notifier")

        if resolved_recognizer.status is not ModelStatus.READY and model_task is not None:
            model_notifier = watch_model(model_task)
        session: AsrSession | None = None
        try:
            while True:
                packet = await websocket.receive()
                if packet["type"] == "websocket.disconnect":
                    break
                payload = packet.get("bytes")
                if payload is not None:
                    if session is None:
                        await send(
                            {
                                "type": "error",
                                "code": "stream_not_started",
                                "recoverable": True,
                                "message": "Send a start message before audio frames.",
                            }
                        )
                    else:
                        try:
                            await session.feed(payload)
                        except ValueError as exc:
                            telemetry.count("invalid_audio")
                            await send(
                                {
                                    "type": "error",
                                    "code": "invalid_audio",
                                    "recoverable": True,
                                    "message": str(exc),
                                }
                            )
                    continue

                text = packet.get("text")
                if text is None:
                    continue
                message = _parse_client_message(text)
                message_type = message.get("type")
                if message_type == "start":
                    if resolved_recognizer.status is not ModelStatus.READY:
                        await send(_model_message(resolved_recognizer, resolved_settings))
                        continue
                    if session is not None:
                        await session.close()
                    session = AsrSession(
                        resolved_recognizer,
                        resolved_settings,
                        send,
                        telemetry=telemetry,
                        speaker_gate=speaker_gate if speaker_gate.enrolled else None,
                    )
                    await session.start()
                    await send({"type": "listening"})
                elif message_type == "stop":
                    if session is not None:
                        await session.stop()
                        await session.close()
                        session = None
                    else:
                        await send({"type": "stopped", "droppedPartials": 0})
                elif message_type == "context":
                    expectation = parse_expectation(message.get("expect"))
                    if session is not None:
                        session.set_expectation(expectation)
                    elif isinstance(resolved_recognizer, RoutedRecognizer):
                        resolved_recognizer.set_expectation(expectation)
                    await send({"type": "context_ack", "expect": expectation.value})
                elif message_type == "ping":
                    await send({"type": "pong"})
                elif message_type == "retry_model":
                    if resolved_recognizer.status in {ModelStatus.IDLE, ModelStatus.ERROR}:
                        resolved_recognizer.status = ModelStatus.LOADING
                        resolved_recognizer.error = None
                        model_task = asyncio.create_task(
                            _load_model(resolved_recognizer, telemetry)
                        )
                        app.state.model_task = model_task
                        if model_notifier is not None and not model_notifier.done():
                            model_notifier.cancel()
                        model_notifier = watch_model(model_task)
                    await send(_model_message(resolved_recognizer, resolved_settings))
                else:
                    await send(
                        {
                            "type": "error",
                            "code": "invalid_message",
                            "recoverable": True,
                            "message": (
                                "Expected a start, stop, context, ping, or retry_model message."
                            ),
                        }
                    )
        except WebSocketDisconnect:
            pass
        finally:
            if model_notifier is not None and not model_notifier.done():
                model_notifier.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await model_notifier
            if session is not None:
                with contextlib.suppress(Exception):
                    await session.close()

    return app


async def _load_model(recognizer: Recognizer, telemetry: Telemetry) -> None:
    started = time.perf_counter()
    try:
        await recognizer.load()
    except Exception:
        # The state and safe-to-display error are exposed through the health endpoint.
        telemetry.count("model_load_failures")
        return
    telemetry.count("model_loads")
    telemetry.observe("model_load_ms", (time.perf_counter() - started) * 1_000)


def _model_message(recognizer: Recognizer, settings: Settings) -> dict[str, Any]:
    message_type = "model_ready" if recognizer.status is ModelStatus.READY else "model_status"
    return {
        "type": message_type,
        "status": recognizer.status.value,
        "model": recognizer.model_name,
        "device": recognizer.device,
        "computeType": recognizer.compute_type,
        "sampleRate": settings.sample_rate,
        "engine": settings.engine.value,
        "error": recognizer.error,
    }


def _parse_client_message(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _load_fixture_ids(path: Path) -> frozenset[str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        scenarios = value["scenarios"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise RuntimeError(f"Cannot load dental fixture manifest at {path}") from error
    if (
        value.get("schemaVersion") != 1
        or value.get("sampleRate") != FIXTURE_SAMPLE_RATE
        or value.get("passes") != ["quiet", "noise"]
    ):
        raise RuntimeError(f"Incompatible dental fixture manifest at {path}")

    ids: set[str] = set()
    try:
        for scenario in scenarios:
            for utterance in scenario["utterances"]:
                utterance_id = utterance["id"]
                if (
                    not isinstance(utterance_id, str)
                    or SAFE_FIXTURE_ID.fullmatch(utterance_id) is None
                ):
                    raise ValueError("unsafe utterance id")
                if utterance_id in ids:
                    raise ValueError("duplicate utterance id")
                ids.add(utterance_id)
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError(f"Invalid dental fixture manifest at {path}") from error
    if not ids:
        raise RuntimeError(f"Dental fixture manifest has no utterances at {path}")
    return frozenset(ids)


def _validate_fixture_pcm(pcm: bytes) -> None:
    if not pcm:
        raise HTTPException(status_code=400, detail="Fixture PCM must not be empty.")
    if len(pcm) % 2:
        raise HTTPException(status_code=400, detail="Fixture PCM16 must contain complete samples.")
    if len(pcm) > MAX_FIXTURE_PCM_BYTES:
        raise HTTPException(status_code=413, detail="Fixture clip exceeds 30 seconds.")


def _write_fixture_wav(destination: Path, pcm: bytes) -> None:
    FIXTURE_AUDIO_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    FIXTURE_AUDIO_DIR.chmod(0o700)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination.parent.chmod(0o700)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.stem}-",
        suffix=".tmp",
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with wave.open(str(temporary), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(FIXTURE_SAMPLE_RATE)
            wav_file.writeframes(pcm)
        temporary.chmod(0o600)
        os.replace(temporary, destination)
        destination.chmod(0o600)
    finally:
        temporary.unlink(missing_ok=True)


app = create_app()
