"""Enrollment must complete from one ordinary take, without a raised voice.

The original voicing test measured each frame against the loudest frame in the
clip, which discarded roughly a third of real speech: six seconds of continuous
speech produced 1,870 ms of "voiced" audio against a 2,000 ms requirement, so
enrollment failed no matter how long someone spoke. Shouting appeared to help
only because it dragged more frames over a peak-relative bar.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from faster_whisper.audio import decode_audio
from numpy.typing import NDArray

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.config import Settings
from server.speaker import SpeakerGate, profile

FIXTURE = Path("tests/fixtures/jfk.flac")
TAKE_SECONDS = 6.0


def main() -> int:
    settings = Settings.from_env()
    speech: NDArray[np.float32] = decode_audio(str(FIXTURE), sampling_rate=settings.sample_rate)
    take = speech[: int(TAKE_SECONDS * settings.sample_rate)]
    failures: list[str] = []

    voiced = profile(take, settings.sample_rate).voiced_ms
    if voiced < settings.speaker_enroll_ms:
        failures.append(
            f"{TAKE_SECONDS:.0f} s of continuous speech yielded {voiced} ms of usable audio, "
            f"below the {settings.speaker_enroll_ms} ms enrollment requirement"
        )

    gate = SpeakerGate(settings)
    gate.enroll(take)
    state = gate.state()
    if not state.enrolled:
        failures.append("a single ordinary take did not complete enrollment")
    if state.voiced_ms < state.required_ms:
        failures.append(f"reported progress {state.voiced_ms}/{state.required_ms} ms")

    # A quiet speaker must also work: halving the level must not halve the speech.
    quiet = (take * 0.25).astype(np.float32)
    quiet_voiced = profile(quiet, settings.sample_rate).voiced_ms
    if quiet_voiced < settings.speaker_enroll_ms:
        failures.append(
            f"a quieter take yielded only {quiet_voiced} ms of usable audio, so the "
            f"detector is still level-dependent"
        )

    # A single loud transient must not suppress the rest of the take.
    spiked = take.copy()
    spiked[len(spiked) // 2] = 1.0
    spiked_voiced = profile(spiked, settings.sample_rate).voiced_ms
    if spiked_voiced < settings.speaker_enroll_ms:
        failures.append(
            f"one loud sample reduced usable audio to {spiked_voiced} ms, so a knock on "
            f"the microphone still breaks enrollment"
        )

    # Accumulation across takes has to work, since that is what the interface offers.
    partial = SpeakerGate(settings)
    short = int(1.2 * settings.sample_rate)
    for index in range(4):
        partial.enroll(take[index * short : (index + 1) * short])
    if not partial.state().enrolled:
        failures.append("four short takes did not accumulate into a completed enrollment")

    need = settings.speaker_enroll_ms
    print(f"one {TAKE_SECONDS:.0f} s take        : {voiced} ms usable (need {need})")
    print(f"quarter-level take   : {quiet_voiced} ms usable")
    print(f"take with a transient: {spiked_voiced} ms usable")
    print(f"four short takes     : enrolled={partial.state().enrolled}")
    for failure in failures:
        print(f"FAIL: {failure}")
    print("ENROLLMENT_GATE_PASSED" if not failures else "ENROLLMENT_GATE_FAILED")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
