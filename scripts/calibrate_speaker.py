"""Re-measures the separation the speaker thresholds depend on.

Run this after any change to the profile features or the fixture. It prints the
worst same-speaker score, the best other-speaker score, and where the configured
thresholds sit between them.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from faster_whisper.audio import decode_audio
from numpy.typing import NDArray

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.config import Settings
from server.speaker import SpeakerGate

FIXTURE = Path("tests/fixtures/jfk.flac")


def shift(audio: NDArray[np.float32], factor: float) -> NDArray[np.float32]:
    count = int(len(audio) / factor)
    positions = np.arange(count) * factor
    lower = np.clip(np.floor(positions).astype(int), 0, len(audio) - 2)
    fraction = positions - lower
    rendered: NDArray[np.float32] = (
        (1 - fraction) * audio[lower] + fraction * audio[lower + 1]
    ).astype(np.float32)
    return rendered


def main() -> int:
    settings = Settings.from_env()
    speech: NDArray[np.float32] = decode_audio(str(FIXTURE), sampling_rate=settings.sample_rate)
    gate = SpeakerGate(settings)
    gate.enroll(speech)

    half = len(speech) // 2
    same = [speech[:half], speech[half:], speech[int(0.2 * len(speech)) : int(0.7 * len(speech))]]
    other: list[NDArray[np.float32]] = []
    for factor in (1.2, 1.3, 1.45, 0.8, 0.72):
        rendered = shift(speech, factor)
        cut = len(rendered) // 2
        other.extend([rendered[:cut], rendered[cut:]])

    positives = [gate.verify(segment) for segment in same]
    negatives = [gate.verify(segment) for segment in other]
    worst_positive = min(verdict.similarity for verdict in positives)
    best_negative = max(verdict.similarity for verdict in negatives)

    print(f"enrolled speaker, worst held-out score : {worst_positive:.4f}")
    print(f"other voices, best score               : {best_negative:.4f}")
    thresholds = f"{settings.speaker_accept} / {settings.speaker_reject}"
    print(f"configured accept / reject             : {thresholds}")
    print(f"margin                                 : {worst_positive - best_negative:+.4f}")

    ok = best_negative < settings.speaker_reject < settings.speaker_accept <= worst_positive
    print("SPEAKER_CALIBRATION_OK" if ok else "SPEAKER_CALIBRATION_OUT_OF_RANGE")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
