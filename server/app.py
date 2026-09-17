from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from server.config import Settings
from server.recognizer import FasterWhisperRecognizer, ModelStatus, Recognizer
from server.session import AsrSession

PROTOCOL_VERSION = 1


def create_app(
    recognizer: Recognizer | None = None,
    settings: Settings | None = None,
    *,
    preload: bool = True,
) -> FastAPI:
    resolved_settings = settings or Settings.from_env()
    resolved_recognizer = recognizer or FasterWhisperRecognizer(resolved_settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.model_task = None
        if preload:
            app.state.model_task = asyncio.create_task(_load_model(resolved_recognizer))
        yield
        task: asyncio.Task[None] | None = app.state.model_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = FastAPI(title="Perio Voice Local ASR", version="0.2.0", lifespan=lifespan)
    app.state.recognizer = resolved_recognizer
    app.state.settings = resolved_settings

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return _model_message(resolved_recognizer, resolved_settings)

    @app.websocket("/ws/asr")
    async def asr_socket(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        if origin is not None and origin not in resolved_settings.allowed_origins:
            await websocket.close(code=1008, reason="WebSocket origin is not allowed.")
            return
        await websocket.accept()
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
                    session = AsrSession(resolved_recognizer, resolved_settings, send)
                    await session.start()
                    await send({"type": "listening"})
                elif message_type == "stop":
                    if session is not None:
                        await session.stop()
                        await session.close()
                        session = None
                    else:
                        await send({"type": "stopped", "droppedPartials": 0})
                elif message_type == "ping":
                    await send({"type": "pong"})
                elif message_type == "retry_model":
                    if resolved_recognizer.status in {ModelStatus.IDLE, ModelStatus.ERROR}:
                        resolved_recognizer.status = ModelStatus.LOADING
                        resolved_recognizer.error = None
                        model_task = asyncio.create_task(_load_model(resolved_recognizer))
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
                            "message": "Expected a start, stop, ping, or retry_model message.",
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


async def _load_model(recognizer: Recognizer) -> None:
    try:
        await recognizer.load()
    except Exception:
        # The state and safe-to-display error are exposed through the health endpoint.
        return


def _model_message(recognizer: Recognizer, settings: Settings) -> dict[str, Any]:
    message_type = "model_ready" if recognizer.status is ModelStatus.READY else "model_status"
    return {
        "type": message_type,
        "status": recognizer.status.value,
        "model": recognizer.model_name,
        "device": recognizer.device,
        "computeType": recognizer.compute_type,
        "sampleRate": settings.sample_rate,
        "error": recognizer.error,
    }


def _parse_client_message(text: str) -> dict[str, Any]:
    import json

    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


app = create_app()
