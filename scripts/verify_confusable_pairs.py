"""Named regression guard for the confusions that reached real charting.

Each entry here was reported from use or found by the substitution gate, and each
one wrote the wrong thing into a chart. They are tested in the phrase context a
clinician actually says them in, because isolated words are both a harsher test
and a less relevant one.

History, so a future change knows what it is protecting:

- `buccal` was heard as `pocket` while depths were expected, because the grammar
  had been narrowed and `pocket` was the nearest permitted word.
- `three` was heard as `free`, which was in the grammar for "free of bleeding".
- "can you pass me that" was heard as `pus meant that`, charting suppuration.
- `skip` was heard as `teeth`; `labial` was heard as `mobile`.
- `two` and `tooth` are genuinely close and both must stay, so both are checked
  in the contexts that distinguish them.
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
from server.vocabulary import Expectation

FIXTURE = Path("evaluation/fixtures/synthetic-dental")
"""Words that must never be emitted at all: each was removed after charting the
wrong thing, so their reappearance is a regression in itself."""
BANNED = ("pocket", "free", "pus", "teeth", "mobile")

"""Forms the browser lattice folds before anything reaches the chart.

`src/domain/lattice.ts` resolves these to digits against the clinical context, so
hearing "to" where "two" was said is not a clinical error — the chart still gets
2. This gate is about confusions that change the record, so it compares the
resolved form rather than the raw transcript. Anything not listed here is
compared literally."""
FOLDED: dict[str, str] = {
    "to": "two",
    "too": "two",
    "for": "four",
    "ate": "eight",
    "won": "one",
    "tree": "three",
}


def resolved(text: str) -> str:
    return " ".join(FOLDED.get(word, word) for word in text.split())


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
    contrast: dict[str, str] = json.loads((FIXTURE / "contrast.json").read_text(encoding="utf-8"))
    recognizer = VoskGrammarRecognizer(settings)
    await recognizer.load()

    failures: list[str] = []
    # Checked under the expectation that used to narrow, so the historical
    # failure would reappear here if narrowing ever returned.
    for expectation in (Expectation.DEPTHS, Expectation.CLINICAL):
        recognizer.set_expectation(expectation)
        for name, spoken in sorted(contrast.items()):
            clip = load(FIXTURE / "contrast" / f"{name}.wav", settings.sample_rate)
            result = await recognizer.transcribe(clip, partial=False)
            heard = result.text.strip()
            if resolved(heard) != resolved(spoken):
                failures.append(f"[{expectation.value}] {spoken!r} heard as {heard!r}")
            banned = [word for word in BANNED if word in heard.split()]
            if banned:
                failures.append(
                    f"[{expectation.value}] {spoken!r} emitted a removed word {banned}: {heard!r}"
                )

    checked = len(contrast) * 2
    print(f"contrast utterances checked : {checked}")
    print(f"removed words guarded       : {', '.join(BANNED)}")
    print(f"mismatches                  : {len(failures)}")
    for failure in failures[:12]:
        print(f"FAIL: {failure}")
    print("CONFUSABLE_PAIRS_GATE_PASSED" if not failures else "CONFUSABLE_PAIRS_GATE_FAILED")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
