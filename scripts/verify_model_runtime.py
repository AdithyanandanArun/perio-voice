from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import replace
from pathlib import Path

from faster_whisper.audio import decode_audio

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.config import Settings
from server.recognizer import FasterWhisperRecognizer, ModelStatus

FIXTURE = Path("tests/fixtures/jfk.flac")


async def verify() -> None:
    settings = replace(
        Settings.from_env(),
        model_name=os.getenv("ASR_TEST_MODEL", "tiny.en"),
        device=os.getenv("ASR_TEST_DEVICE", "cpu"),
        compute_type=os.getenv("ASR_TEST_COMPUTE_TYPE", "int8"),
    )
    recognizer = FasterWhisperRecognizer(settings)
    await recognizer.load()
    if recognizer.status is not ModelStatus.READY:
        raise RuntimeError(f"Model did not become ready: {recognizer.error}")

    audio = decode_audio(str(FIXTURE), sampling_rate=settings.sample_rate)
    result = await recognizer.transcribe(audio, partial=False)
    normalized = result.text.casefold()
    required = ("fellow", "americans", "country")
    matched = [word for word in required if word in normalized]
    if len(matched) < 2:
        raise AssertionError(
            f"Recognition did not contain enough expected JFK words. Transcript: {result.text!r}"
        )
    if not result.words:
        raise AssertionError("Final recognition did not provide word timestamps.")

    print(
        f"model={recognizer.model_name} device={recognizer.device} "
        f"decode_ms={result.decode_ms} transcript={result.text!r}"
    )
    print("ACTIVE_MODEL_GATE_PASSED")


if __name__ == "__main__":
    if not FIXTURE.is_file():
        raise RuntimeError(f"Missing known-speech fixture: {FIXTURE}")
    asyncio.run(verify())
