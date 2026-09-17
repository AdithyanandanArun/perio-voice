"""A grammar must never turn a clinical word into a different clinical word.

This is the gate for the defect that prompted it. Saying "buccal" while probing
depths were expected was charted as "pocket", because the grammar had been
narrowed and `buccal` was no longer something the decoder was permitted to emit.
A constrained decoder does not decline words outside its grammar; it picks the
nearest word inside it. Exclusion therefore produces confident wrong answers, not
refusals, which is the worst possible failure for a clinical record.

Two checks. The static one is that every clinical word is reachable under every
expectation the product can declare, so nothing can be narrowed out again. The
empirical one hears each word and requires that it never comes back as a
different clinical word.
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
from server.vocabulary import Expectation, every_word, grammar_for

FIXTURE = Path("evaluation/fixtures/synthetic-dental")
"""Words that carry clinical meaning: substituting one of these writes a chart
entry that was never spoken. Function words are excluded because swapping "of"
for "or" changes nothing downstream."""
FUNCTION_WORDS = frozenset(
    {
        "of",
        "or",
        "and",
        "to",
        "that",
        "this",
        "it",
        "on",
        "up",
        "go",
        "over",
        "not",
        "no",
        "none",
        "make",
        "meant",
        "rather",
        "instead",
        "again",
        "start",
        "move",
        "level",
        "surface",
        "mid",
        "number",
        "class",
        "grade",
    }
)
"""Recognizing a word as nothing is a miss, not a substitution. Misses are
reported and bounded; substitutions are never allowed."""
MAX_MISS_RATE = 0.20


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
    failures: list[str] = []

    # Static: nothing may be unreachable under any expectation the product declares.
    declared = every_word()
    for expectation in Expectation:
        reachable = set(grammar_for(expectation))
        missing = declared - reachable
        if missing:
            failures.append(
                f"expectation {expectation.value} cannot emit "
                f"{len(missing)} clinical word(s) that other contexts can, so speech "
                f"containing them will be substituted: {', '.join(sorted(missing)[:6])}"
            )

    # Empirical: hear every word and require it is never another clinical word.
    vocabulary: dict[str, str] = json.loads(
        (FIXTURE / "vocabulary.json").read_text(encoding="utf-8")
    )
    recognizer = VoskGrammarRecognizer(settings)
    await recognizer.load()
    recognizer.set_expectation(Expectation.DEPTHS)

    stale = {word for word in vocabulary.values() if word not in declared}
    if stale:
        failures.append(
            f"the vocabulary fixture contains audio for {len(stale)} word(s) the "
            f"product no longer knows; regenerate it: {', '.join(sorted(stale))}"
        )
    clinical = {word for word in declared if word not in FUNCTION_WORDS}
    substitutions: list[str] = []
    misses: list[str] = []
    for name, word in sorted(vocabulary.items()):
        clip = load(FIXTURE / "vocabulary" / f"{name}.wav", settings.sample_rate)
        result = await recognizer.transcribe(clip, partial=False)
        heard = result.text.split()
        if heard == [word] or not heard:
            if not heard:
                misses.append(word)
            continue
        wrong = [token for token in heard if token in clinical and token != word]
        if wrong:
            substitutions.append(f"{word!r} heard as {' '.join(heard)!r}")

    if substitutions:
        failures.append(
            f"{len(substitutions)} clinical word(s) were recognized as a different "
            f"clinical word: " + "; ".join(substitutions[:8])
        )
    miss_rate = len(misses) / max(1, len(vocabulary))
    if miss_rate > MAX_MISS_RATE:
        failures.append(
            f"{miss_rate:.0%} of clinical words were not recognized at all "
            f"(limit {MAX_MISS_RATE:.0%}): {', '.join(misses[:8])}"
        )

    print(f"clinical vocabulary       : {len(declared)} words, {len(clinical)} chart-bearing")
    print(f"reachable under every expectation: {'yes' if not failures else 'no'}")
    print(f"heard as a different clinical word: {len(substitutions)}")
    print(f"not recognized at all     : {len(misses)} ({miss_rate:.0%}) {', '.join(misses[:8])}")
    for failure in failures:
        print(f"FAIL: {failure}")
    print(
        "NO_FORCED_SUBSTITUTION_GATE_PASSED"
        if not failures
        else "NO_FORCED_SUBSTITUTION_GATE_FAILED"
    )
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
