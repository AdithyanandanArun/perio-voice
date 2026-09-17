"""A short clinical utterance must produce a decision, not a permanent unknown.

`speaker_min_ms` was 400 ms, but "three" carries roughly 300 ms of voiced audio,
so single-digit utterances could never be verified at all: with attribution
enabled every one of them was held for confirmation.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from faster_whisper.audio import decode_audio
from numpy.typing import NDArray

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.config import Settings
from server.speaker import SpeakerDecision, SpeakerGate, profile

FIXTURE = Path("tests/fixtures/jfk.flac")
"""Durations a clinician actually produces: "three" up to a short phrase."""
CLINICAL_SECONDS = (0.4, 0.5, 0.8, 1.2)


def main() -> int:
    settings = Settings.from_env()
    speech: NDArray[np.float32] = decode_audio(str(FIXTURE), sampling_rate=settings.sample_rate)
    gate = SpeakerGate(settings)
    gate.enroll(speech[: 6 * settings.sample_rate])
    failures: list[str] = []

    for seconds in CLINICAL_SECONDS:
        clip = speech[
            settings.sample_rate : settings.sample_rate + int(seconds * settings.sample_rate)
        ]
        voiced = profile(clip, settings.sample_rate).voiced_ms
        if voiced < settings.speaker_min_ms:
            failures.append(
                f"a {seconds:.1f} s utterance carries {voiced} ms of speech, below the "
                f"{settings.speaker_min_ms} ms floor, so it can never be verified"
            )
        print(f"{seconds:.1f} s utterance -> {voiced} ms voiced (floor {settings.speaker_min_ms})")

    # Once the rolling window has filled, short utterances must reach a decision.
    gate.forget_window()
    decisions = []
    for index in range(8):
        offset = 6 * settings.sample_rate + index * int(0.6 * settings.sample_rate)
        clip = speech[offset : offset + int(0.6 * settings.sample_rate)]
        if clip.size == 0:
            break
        decisions.append(gate.verify(clip).decision)
    settled = decisions[3:]
    if not settled:
        failures.append("the rolling window never produced a settled decision")
    elif all(decision is SpeakerDecision.UNKNOWN for decision in settled):
        failures.append(
            "every short utterance stayed unknown even after the attribution window filled"
        )
    print(f"settled decisions    : {[d.value for d in settled]}")

    for failure in failures:
        print(f"FAIL: {failure}")
    print("SHORT_VERIFICATION_GATE_PASSED" if not failures else "SHORT_VERIFICATION_GATE_FAILED")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
