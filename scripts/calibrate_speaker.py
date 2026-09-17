"""Re-measures the separation the speaker thresholds depend on.

The thresholds were originally calibrated by comparing 5.5-second segments
against 5.5-second segments from one recording. That is not the comparison the
product makes. It enrolls on several seconds of continuous speech and then
verifies half-second clinical utterances against it, and a short clip's spectral
profile is measurably further from a long enrollment even for the same speaker.
Calibrating on the wrong pairing made every real utterance land below the accept
threshold and be held as unknown.

This measures at the durations actually used, so the numbers describe the
decision the gate makes.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from faster_whisper.audio import decode_audio
from numpy.typing import NDArray

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.config import Settings
from server.speaker import SpeakerGate, SpeakerVerdict

FIXTURE = Path("tests/fixtures/jfk.flac")
"""Durations a clinician actually produces while charting."""
VERIFY_SECONDS = (0.5, 0.8, 1.2, 2.0, 3.0)
ENROLL_SECONDS = 6.0
SHIFT_FACTORS = (1.2, 1.3, 1.45, 0.8, 0.72)


def shift(audio: NDArray[np.float32], factor: float) -> NDArray[np.float32]:
    count = int(len(audio) / factor)
    positions = np.arange(count) * factor
    lower = np.clip(np.floor(positions).astype(int), 0, len(audio) - 2)
    fraction = positions - lower
    rendered: NDArray[np.float32] = (
        (1 - fraction) * audio[lower] + fraction * audio[lower + 1]
    ).astype(np.float32)
    return rendered


def _clips(audio: NDArray[np.float32], sample_rate: int) -> list[NDArray[np.float32]]:
    """Short excerpts taken from after the enrollment region."""
    start = int(ENROLL_SECONDS * sample_rate)
    clips: list[NDArray[np.float32]] = []
    for seconds in VERIFY_SECONDS:
        width = int(seconds * sample_rate)
        for offset in (0, width):
            begin = start + offset
            if begin + width <= len(audio):
                clips.append(audio[begin : begin + width])
    return clips


def main() -> int:
    settings = Settings.from_env()
    speech: NDArray[np.float32] = decode_audio(str(FIXTURE), sampling_rate=settings.sample_rate)
    gate = SpeakerGate(settings)
    gate.enroll(speech[: int(ENROLL_SECONDS * settings.sample_rate)])
    if not gate.state().enrolled:
        print("enrollment did not complete from a single ordinary take")
        return 1

    # Each speaker is judged from its own rolling window, exactly as the service
    # does, so the window has to be cleared between speakers.
    gate.forget_window()
    positives = [gate.verify(clip) for clip in _clips(speech, settings.sample_rate)]
    negatives: list[SpeakerVerdict] = []
    for factor in SHIFT_FACTORS:
        rendered = shift(speech, factor)
        gate.forget_window()
        negatives.extend(gate.verify(clip) for clip in _clips(rendered, settings.sample_rate))
    gate.forget_window()

    usable_positive = [v.similarity for v in positives if v.similarity > 0]
    usable_negative = [v.similarity for v in negatives if v.similarity > 0]
    worst_positive = min(usable_positive)
    best_negative = max(usable_negative)

    print(f"enrollment take                        : {ENROLL_SECONDS:.0f} s, one take")
    print(f"verification clips                     : {len(positives)} at {VERIFY_SECONDS} s")
    print(f"enrolled speaker, worst score          : {worst_positive:.4f}")
    print(f"other voices, best score               : {best_negative:.4f}")
    thresholds = f"{settings.speaker_accept} / {settings.speaker_reject}"
    print(f"configured accept / reject             : {thresholds}")
    print(f"margin                                 : {worst_positive - best_negative:+.4f}")

    # Attribution needs a few seconds of speech before it can decide at all,
    # so only judge holds once the window is full.
    settled = positives[len(VERIFY_SECONDS) :]
    held = sum(1 for v in settled if v.decision.value == "unknown")
    print(f"enrolled clinician held once settled   : {held}/{len(settled)}")
    print(f"attribution window                     : {settings.speaker_window_ms} ms")

    ok = (
        best_negative < settings.speaker_reject
        and settings.speaker_accept <= worst_positive
        and held == 0
    )
    print("SPEAKER_CALIBRATION_OK" if ok else "SPEAKER_CALIBRATION_OUT_OF_RANGE")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
