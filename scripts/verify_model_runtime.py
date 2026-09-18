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
    if not recognizer.warmup.completed:
        raise RuntimeError("Model reported ready without completing inference warmup.")
    if recognizer.warmup.duration_ms is None:
        raise RuntimeError("Model warmup did not report a duration.")
    sweep_options = {
        beam: recognizer.decoder_options(partial=False, beam_size=beam) for beam in (1, 5)
    }
    if sweep_options[1]["beam_size"] != 1 or sweep_options[5]["beam_size"] != 5:
        raise RuntimeError("Decoder beam overrides are not exposed independently of runtime state.")
    if recognizer.beam_size != settings.beam_size:
        raise RuntimeError("A decoder sweep mutated the production beam size.")

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
        f"warmup_ms={recognizer.warmup.duration_ms} decode_ms={result.decode_ms} "
        f"transcript={result.text!r}"
    )
    print("ACTIVE_MODEL_GATE_PASSED")


if __name__ == "__main__":
    if not FIXTURE.is_file():
        raise RuntimeError(f"Missing known-speech fixture: {FIXTURE}")
    asyncio.run(verify())
