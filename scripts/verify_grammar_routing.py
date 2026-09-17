"""Clinical context must select the grammar, and speech outside it must not chart.

The value of a constrained recognizer is not only that it is more accurate. It is
that while the chart is waiting for probing depths, a wrong clinical value is not
in the set of things the decoder can produce. This checks that property directly
rather than trusting it.
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
from server.routed_recognizer import RoutedRecognizer
from server.routing import Engine
from server.vocabulary import (
    DIGITS,
    FINDING_WORDS,
    UNKNOWN_TOKEN,
    Expectation,
    grammar_for,
    parse_expectation,
)

FIXTURE = Path("evaluation/fixtures/synthetic-dental")


def load_clip(path: Path, sample_rate: int) -> NDArray[np.float32]:
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
    truth: dict[str, str] = json.loads((FIXTURE / "truth.json").read_text(encoding="utf-8"))
    failures: list[str] = []

    # 1. Expectation selects the engine, and it is decided by context, not confidence.
    routed = RoutedRecognizer(settings)
    for expectation, expected_engine in (
        (Expectation.DEPTHS, "grammar"),
        (Expectation.TOOTH, "grammar"),
        (Expectation.CLINICAL, "grammar"),
        (Expectation.FREE, "whisper"),
    ):
        routed.set_expectation(expectation)
        if routed.route() != expected_engine:
            failures.append(
                f"expectation {expectation.value} routed to {routed.route()}, "
                f"expected {expected_engine}"
            )
    print("routing by expectation: checked")

    # 2. No expectation may narrow the vocabulary.
    #
    # This assertion used to be the opposite: it required the depth grammar to
    # exclude surface names. That was the bug. A constrained decoder does not
    # decline words outside its grammar, it emits the nearest word inside it, so
    # saying "buccal" while depths were expected was charted as "pocket". A
    # clinician may say anything at any moment, so every expectation must reach
    # the whole clinical vocabulary.
    depth_words = set(grammar_for(Expectation.DEPTHS))
    for surface in ("buccal", "lingual"):
        if surface not in depth_words:
            failures.append(
                f"the depth grammar cannot emit {surface!r}, so saying it while depths "
                f"are expected will be substituted rather than heard"
            )
    if not set(DIGITS).issubset(depth_words):
        failures.append("the depth grammar cannot emit every legal probing depth")
    if "thirty" not in depth_words:
        failures.append("the depth grammar cannot reach the upper tooth numbers")
    for expectation in Expectation:
        if set(grammar_for(expectation)) != depth_words:
            failures.append(
                f"expectation {expectation.value} reaches a different vocabulary than "
                f"{Expectation.DEPTHS.value}, so narrowing has returned"
            )

    # 3. Out-of-grammar speech must yield no clinical value.
    grammar = VoskGrammarRecognizer(settings)
    await grammar.load()
    grammar.set_expectation(Expectation.DEPTHS)
    for utterance_id in ("n1", "n2"):
        clip = load_clip(FIXTURE / "audio" / f"{utterance_id}.wav", settings.sample_rate)
        result = await grammar.transcribe(clip, partial=False)
        spoken = truth[utterance_id]
        # Non-chartable speech may return nothing, but must not return anything
        # that would become a chart entry: a value or a finding.
        chartable = set(DIGITS) | set(FINDING_WORDS)
        emitted = chartable.intersection(result.text.split())
        if emitted:
            failures.append(
                f"conversational speech {spoken!r} produced chartable content "
                f"{sorted(emitted)} ({result.text!r}) while depths were expected"
            )
        print(f"out of grammar {spoken!r} -> {result.text!r} (unknown {result.unknown_ratio:.2f})")

    # 4. Inside the grammar, a digit utterance must come back as that digit.
    grammar.set_expectation(Expectation.DEPTHS)
    for utterance_id in ("s1", "s2", "d1"):
        clip = load_clip(FIXTURE / "audio" / f"{utterance_id}.wav", settings.sample_rate)
        result = await grammar.transcribe(clip, partial=False)
        print(f"in grammar     {truth[utterance_id]!r} -> {result.text!r}")
        if not result.text.strip():
            failures.append(f"{truth[utterance_id]!r} produced nothing while depths were expected")
        # A digit utterance must come back as that digit, not a near-homophone
        # that happens to also be in the grammar.
        if result.text.strip() != truth[utterance_id]:
            failures.append(
                f"{truth[utterance_id]!r} was recognized as {result.text.strip()!r}; the "
                f"grammar contains a competing near-homophone"
            )

    # 5. The unknown marker must never reach the clinical pipeline as text.
    if (
        UNKNOWN_TOKEN
        in (
            await grammar.transcribe(
                load_clip(FIXTURE / "audio" / "n1.wav", settings.sample_rate), partial=False
            )
        ).text
    ):
        failures.append("the out-of-grammar marker leaked into the transcript")

    # 6. An explicit engine override must win over the expectation.
    forced = RoutedRecognizer(Settings(engine=Engine.WHISPER))
    forced.set_expectation(Expectation.DEPTHS)
    if forced.route() != "whisper":
        failures.append("ASR_ENGINE=whisper did not override expectation-based routing")
    if parse_expectation("nonsense") is not Expectation.CLINICAL:
        failures.append("an unknown expectation did not fall back to the full clinical grammar")

    for failure in failures:
        print(f"FAIL: {failure}")
    print("GRAMMAR_ROUTING_GATE_PASSED" if not failures else "GRAMMAR_ROUTING_GATE_FAILED")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
