"""The recognizer must expose competing readings, not just its favourite one.

Short clinical words are often genuinely ambiguous to an acoustic model. Measured
on this fixture, "two" comes back as "to" and "two" at identical confidence, and
"tooth two" as "tooth to" and "tooth two" at identical confidence. Committing to
whichever one sorted first is an arbitrary tie-break on a clinical value.

Exposing the alternatives lets `src/domain/pipeline.ts` re-read an utterance that
carried no clinical meaning, using the context that actually knows which reading
was possible. This checks that they are produced, ranked, and distinct.
"""

from __future__ import annotations

import asyncio
import json
import sys
import wave
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.config import Settings
from server.grammar_recognizer import VoskGrammarRecognizer
from server.vocabulary import UNKNOWN_TOKEN, Expectation

FIXTURE = Path("evaluation/fixtures/synthetic-dental")
"""Utterances known to be acoustically ambiguous; each must offer a choice."""
AMBIGUOUS = ("two_alone", "tooth_two", "two_two")
"""Utterances that are not ambiguous; the top reading must still be correct."""
CLEAR = {"three_seq": "three four five", "buccal_alone": "buccal"}


def load(path: Path, sample_rate: int) -> NDArray[np.float32]:
    with wave.open(str(path), "rb") as handle:
        raw = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2")
        source_rate = handle.getframerate()
    samples = raw.astype(np.float32) / 32_768.0
    if source_rate == sample_rate:
        return samples
    positions = np.arange(int(len(samples) * sample_rate / source_rate)) * source_rate / sample_rate
    lower = np.clip(np.floor(positions).astype(int), 0, len(samples) - 2)
    fraction = positions - lower
    out: NDArray[np.float32] = (
        (1 - fraction) * samples[lower] + fraction * samples[lower + 1]
    ).astype(np.float32)
    return out


async def main() -> int:
    settings = Settings.from_env()
    recognizer = VoskGrammarRecognizer(settings)
    await recognizer.load()
    recognizer.set_expectation(Expectation.CLINICAL)
    contrast: dict[str, str] = json.loads((FIXTURE / "contrast.json").read_text(encoding="utf-8"))
    failures: list[str] = []

    if settings.max_alternatives < 2:
        failures.append("ASR_MAX_ALTERNATIVES is below 2, so no choice is ever offered")

    offered = 0
    for name in AMBIGUOUS:
        result = await recognizer.transcribe(
            load(FIXTURE / "contrast" / f"{name}.wav", settings.sample_rate), partial=False
        )
        texts = [item.text for item in result.alternatives]
        print(f"{contrast[name]!r:16s} -> {result.text!r:16s} alternatives: {texts}")
        if len(set(texts)) > 1:
            offered += 1
        if len(texts) > len(set(texts)):
            failures.append(f"{contrast[name]!r} returned duplicate alternatives: {texts}")
        if any(UNKNOWN_TOKEN in text for text in texts):
            failures.append(
                f"{contrast[name]!r} leaked the out-of-grammar marker into an alternative"
            )
        confidences = [item.confidence for item in result.alternatives]
        if confidences != sorted(confidences, reverse=True):
            failures.append(f"{contrast[name]!r} returned alternatives out of rank order")
        if result.alternatives and result.alternatives[0].text != result.text:
            failures.append(
                f"{contrast[name]!r} best alternative {result.alternatives[0].text!r} "
                f"disagrees with the transcript {result.text!r}"
            )

    if offered == 0:
        failures.append(
            "no ambiguous utterance produced a distinct second reading, so the "
            "pipeline has nothing to re-read with"
        )

    # Offering choice must not cost correctness where there was none to make.
    for name, spoken in CLEAR.items():
        result = await recognizer.transcribe(
            load(FIXTURE / "contrast" / f"{name}.wav", settings.sample_rate), partial=False
        )
        if result.text.strip() != spoken:
            failures.append(f"unambiguous {spoken!r} regressed to {result.text!r}")

    print(f"\nambiguous utterances offering a choice: {offered}/{len(AMBIGUOUS)}")
    for failure in failures:
        print(f"FAIL: {failure}")
    print("ALTERNATIVES_GATE_PASSED" if not failures else "ALTERNATIVES_GATE_FAILED")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
