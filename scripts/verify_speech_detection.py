"""Speech detection must follow the room, not a number chosen once.

A fixed absolute threshold has to be set for one microphone at one distance.
Measured on real continuous speech, the tenth percentile of frame level fell
below the configured threshold, so the quietest tenth of genuine speech counted
as silence — which clips word onsets and ends utterances early. That is invisible
to any test that feeds pre-recorded audio at a convenient level, and it is a
plausible part of why recognition was poor from a real microphone.

The negative control matters here: this also checks that the *old* fixed
threshold fails the quiet case, so the gate is measuring the fix rather than
asserting a property that held anyway.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from faster_whisper.audio import decode_audio
from numpy.typing import NDArray

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.audio import SpeechSegmenter, rms_level
from server.config import Settings

FIXTURE = Path("tests/fixtures/jfk.flac")
FRAME_MS = 100
"""What the threshold used to be, kept as the negative control."""
OLD_FIXED_THRESHOLD = 0.012


def voiced_fraction(segmenter: SpeechSegmenter, audio: NDArray[np.float32], rate: int) -> float:
    frame = int(rate * FRAME_MS / 1000)
    voiced = 0
    total = 0
    for start in range(0, len(audio) - frame, frame):
        chunk = audio[start : start + frame]
        total += 1
        if segmenter._is_voiced(rms_level(chunk)):
            voiced += 1
    return voiced / max(1, total)


def fixed_fraction(audio: NDArray[np.float32], rate: int, threshold: float) -> float:
    frame = int(rate * FRAME_MS / 1000)
    levels = [
        rms_level(audio[start : start + frame]) for start in range(0, len(audio) - frame, frame)
    ]
    return sum(1 for level in levels if level >= threshold) / max(1, len(levels))


def main() -> int:
    settings = Settings.from_env()
    rate = settings.sample_rate
    speech: NDArray[np.float32] = decode_audio(str(FIXTURE), sampling_rate=rate)
    rng = np.random.default_rng(17)
    room = (rng.standard_normal(len(speech)) * 0.002).astype(np.float32)

    cases = {
        "speech at normal level": (speech, True),
        "speech from a quiet speaker": ((speech * 0.25).astype(np.float32), True),
        "speech from a distant microphone": ((speech * 0.10).astype(np.float32), True),
        "speech spoken softly": ((speech * 0.05).astype(np.float32), True),
        "speech in a noisy room": (np.clip(speech + room * 4, -1, 1).astype(np.float32), True),
        "room noise alone": (room, False),
        "silence": (np.zeros(rate * 3, dtype=np.float32), False),
    }

    failures: list[str] = []
    print(f"{'case':34s} {'voiced':>8s} {'expected':>10s}")
    print("-" * 56)
    for label, (audio, is_speech) in cases.items():
        fraction = voiced_fraction(SpeechSegmenter(settings), audio, rate)
        ok = fraction >= 0.35 if is_speech else fraction <= 0.05
        print(
            f"{label:34s} {fraction:>7.0%} {'speech' if is_speech else 'not speech':>10s}"
            f"{'' if ok else '   <-- FAIL'}"
        )
        if not ok:
            failures.append(
                f"{label}: {fraction:.0%} of frames counted as speech, "
                f"{'too few' if is_speech else 'too many'}"
            )

    # Negative control: the old fixed threshold must fail on speech this quiet,
    # or this gate is not measuring the change it claims to. At 0.10 the old
    # threshold still coped, so the control uses the level where it does not —
    # a clinician turned away from the microphone, or speaking softly near a
    # sedated patient.
    quiet = (speech * 0.05).astype(np.float32)
    old = fixed_fraction(quiet, rate, OLD_FIXED_THRESHOLD)
    new = voiced_fraction(SpeechSegmenter(settings), quiet, rate)
    print(f"\ndistant speech under the old fixed {OLD_FIXED_THRESHOLD} threshold: {old:.0%} voiced")
    print(f"distant speech under the noise-relative threshold      : {new:.0%} voiced")
    if old >= 0.35:
        failures.append(
            "the old fixed threshold already handled distant speech, so this gate "
            "is not exercising the change it was written for"
        )

    # The absolute floor must still stop a silent room from arming on its own noise.
    silent_room = (rng.standard_normal(rate * 3) * 0.0004).astype(np.float32)
    if voiced_fraction(SpeechSegmenter(settings), silent_room, rate) > 0.05:
        failures.append("a silent room armed the detector on its own noise floor")

    for failure in failures:
        print(f"FAIL: {failure}")
    print("SPEECH_DETECTION_GATE_PASSED" if not failures else "SPEECH_DETECTION_GATE_FAILED")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
