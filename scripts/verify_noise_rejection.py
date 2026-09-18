"""Operatory noise must never become chart text on the recognizer the service runs.

Prompted with example transcriptions, large-v3 recites its prompt when given
noise: endpointed suction, handpiece, chair, scaler and babble bursts came back as
"b o p d three four five." and "three four five.", and its own no-speech estimate
stayed as low as 0.09 -- below real speech. `server/speech_presence.py` refuses
such segments before decoding.

This streams synthesized bursts (six operatory sources, four durations, five
levels, two held-out realizations, plus clicks and saturated captures) through a
real `AsrSession` backed by the real recognizer from `service_settings()`, and
requires that none yields text.

The negative control runs the same bursts with only the Silero check disabled --
the recalibrated no-speech threshold still applies -- and requires that some of
them *do* yield clinical-looking text. Without that, a pass
could mean only that the recognizer happened not to hallucinate today, not that
the check is what stops it.

    uv run --extra gpu python scripts/verify_noise_rejection.py
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from evaluation.noise import synthesize
from server.config import Settings, service_settings
from server.recognizer import FasterWhisperRecognizer
from server.session import AsrSession

SOURCES = ("suction", "handpiece", "chair", "scaler", "hvac", "babble")
DURATIONS_S = (0.3, 0.6, 1.2, 2.0)
LEVELS = (0.01, 0.02, 0.06, 0.15, 0.3)
# The thresholds were chosen on realizations 1-8 of these sources. The gate uses
# 9 and 10, so it tests the thresholds rather than restating their calibration.
# A first version checked only the calibration realizations and passed; the next
# realizations leaked "b o p d three four five." through, which is why.
SEEDS = (9, 10)
CLINICAL_WORDS = frozenset(
    {"two", "three", "four", "five", "six", "tooth", "next", "b", "bleeding", "buccal"}
)


def bursts() -> list[tuple[str, np.ndarray]]:
    rng = np.random.default_rng(23)
    stimuli: list[tuple[str, np.ndarray]] = []
    for source in SOURCES:
        for duration in DURATIONS_S:
            for level in LEVELS:
                for seed in SEEDS:
                    noise = synthesize(source, int(16_000 * duration), 16_000, seed=seed)
                    noise = noise / (np.sqrt(np.mean(noise**2)) or 1.0) * level
                    audio = np.concatenate(
                        [rng.normal(0, 0.001, 8_000), noise, rng.normal(0, 0.001, 16_000)]
                    )
                    stimuli.append((f"{source} {duration}s rms {level} #{seed}", audio))
    for index in range(3):
        # A broken capture path: constant full-scale noise. Prompted large-v3 read
        # one as "b o p d three four five." past both speech checks.
        saturated = np.clip(rng.normal(0, 0.5 + 0.2 * index, 40_000), -1.0, 1.0)
        stimuli.append((f"saturated capture {index}", saturated))
    for index in range(6):
        audio = rng.normal(0, 0.001, 32_000)
        audio[8_000:9_000] += rng.normal(0, 0.05 * (index + 1), 1_000) * np.exp(
            -np.arange(1_000) / 200
        )
        stimuli.append((f"click {index}", audio))
    return stimuli


async def texts_for(
    recognizer: FasterWhisperRecognizer, settings: Settings, audio: np.ndarray
) -> list[str]:
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    session = AsrSession(recognizer, settings, send)
    await session.start()
    pcm = (np.clip(audio, -1, 1) * 32_767).astype("<i2")
    clock = 0.0
    for start in range(0, len(pcm), 1_600):
        clock += 100
        await session.feed(pcm[start : start + 1_600].tobytes(), clock)
    await session.stop(clock + 100)
    await session.close()
    errors = [m for m in messages if m["type"] == "error"]
    if errors:
        # A failed decode also yields no text. Without this, a GPU out of memory
        # would read as perfect rejection.
        raise RuntimeError(f"decode failed: {errors[0].get('message')}")
    return [str(m["text"]) for m in messages if m["type"] == "final" and str(m["text"]).strip()]


def looks_clinical(text: str) -> bool:
    words = {word.strip(".,?!").lower() for word in text.split()}
    return bool(words & CLINICAL_WORDS)


async def main() -> int:
    settings = service_settings()
    if settings.speech_presence_threshold <= 0:
        print(f"FAIL the service runs {settings.model_name} without the speech presence check")
        return 1
    recognizer = FasterWhisperRecognizer(settings)
    await recognizer.load()
    print(
        f"recognizer: {settings.model_name} on {settings.device}, speech presence "
        f"threshold {settings.speech_presence_threshold}"
    )
    stimuli = bursts()

    leaked: list[tuple[str, str]] = []
    for label, audio in stimuli:
        leaked.extend((label, text) for text in await texts_for(recognizer, settings, audio))

    ungated = replace(settings, speech_presence_threshold=0.0)
    control: list[tuple[str, str]] = []
    for label, audio in stimuli:
        control.extend((label, text) for text in await texts_for(recognizer, ungated, audio))
    clinical_control = [(label, text) for label, text in control if looks_clinical(text)]

    print(
        f"{len(stimuli)} bursts: {len(leaked)} texts with every check, {len(control)} "
        "without the Silero check"
    )
    print(f"negative control: {len(clinical_control)} of those look clinical")
    for label, text in clinical_control[:5]:
        print(f"  ungated {label}: {text!r}")
    for label, text in leaked:
        print(f"  LEAKED {label}: {text!r}")
    if leaked:
        print(f"FAIL {len(leaked)} noise bursts produced text")
        return 1
    if not clinical_control:
        print("FAIL negative control: the ungated recognizer produced no clinical text")
        return 1
    print("NOISE_REJECTION_GATE_PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
