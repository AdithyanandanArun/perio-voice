"""Every word a grammar can emit must exist in the recognizer's lexicon.

Vosk drops unknown words from a grammar and reports it only on C-level stderr,
which a Python redirect does not capture. A grammar can therefore list a clinical
term it is structurally incapable of ever emitting, and nothing surfaces it. That
is how `furcation` went unnoticed.

This compares the declared clinical vocabulary against the model and requires the
missing set to equal the gaps recorded in `server/vocabulary.py`, so a newly
missing word fails and a fixed one has to be un-recorded deliberately.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.config import Settings
from server.grammar_recognizer import VoskGrammarRecognizer
from server.vocabulary import KNOWN_LEXICON_GAPS, declared_vocabulary, every_word


async def main() -> int:
    settings = Settings.from_env()
    recognizer = VoskGrammarRecognizer(settings)
    await recognizer.load()

    declared = sorted(declared_vocabulary())
    missing = {word for word in declared if not recognizer.lexicon_contains(word)}
    emittable = every_word()

    failures: list[str] = []
    unexpected = missing - KNOWN_LEXICON_GAPS
    if unexpected:
        failures.append(
            f"clinical words absent from the lexicon and not recorded as gaps: "
            f"{', '.join(sorted(unexpected))}"
        )
    resolved = KNOWN_LEXICON_GAPS - missing
    if resolved:
        failures.append(
            f"recorded as gaps but present in the lexicon; remove them from "
            f"KNOWN_LEXICON_GAPS: {', '.join(sorted(resolved))}"
        )
    # A gap must never be reachable from a grammar, or it silently never matches.
    reachable = emittable & KNOWN_LEXICON_GAPS
    if reachable:
        failures.append(
            f"a grammar can emit words the lexicon lacks: {', '.join(sorted(reachable))}"
        )

    print(f"declared clinical vocabulary : {len(declared)} words")
    print(f"emittable from a grammar     : {len(emittable)} words")
    print(f"recorded lexicon gaps        : {', '.join(sorted(KNOWN_LEXICON_GAPS)) or 'none'}")
    print(f"measured missing             : {', '.join(sorted(missing)) or 'none'}")
    for failure in failures:
        print(f"FAIL: {failure}")
    print("GRAMMAR_LEXICON_GATE_PASSED" if not failures else "GRAMMAR_LEXICON_GATE_FAILED")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
