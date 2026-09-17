"""Clinical grammars.

A general recognizer must decide what was said out of every English word. This
product does not need that: a clinician charting periodontal measurements speaks
from a vocabulary of about eighty words. Handing the recognizer that vocabulary
turns an open-ended guess into a closed choice, and the failure modes that
dominate free-form recognition of short utterances — "for" instead of four,
"Bye bye." out of a handpiece — stop being possible rather than merely unlikely.

One grammar covers all clinical speech. An earlier version narrowed it by
context — digits only while probing depths were expected — which was wrong, and
wrong in a way that produced confident errors rather than refusals. A grammar
does not merely bias the decoder toward the words in it; it makes every other
word impossible, so legitimate speech containing an excluded word is mapped onto
whichever permitted word is acoustically nearest. Saying "buccal" while depths
were expected came back as "pocket", because `buccal` had been narrowed out and
`pocket` was the closest thing left.

That also contradicts the premise of the product: a clinician may say anything at
any moment, and should not have to know what the software is currently prepared
to hear. Narrowing is retained only for the one distinction that is real —
whether the vocabulary must stay open at all.

Words listed here must exist in the recognizer's lexicon or the recognizer
silently drops them, so `scripts/verify_grammar_lexicon.py` checks coverage and
`KNOWN_LEXICON_GAPS` records the ones that are genuinely absent.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final

VOCABULARY_VERSION: Final = "2026.09.1"

"""Vosk's marker for audio that does not fit the grammar. Keeping it available is
what lets conversation come back as "not clinical" instead of as a wrong value."""
UNKNOWN_TOKEN: Final = "[unk]"


class Expectation(StrEnum):
    """What the clinical context is waiting for.

    These select the engine, not the vocabulary: every clinical value resolves to
    the same complete grammar. The distinction that matters is clinical versus
    free-form, because only that one changes which recognizer can answer.
    """

    DEPTHS = "depths"
    TOOTH = "tooth"
    FINDINGS = "findings"
    COMMANDS = "commands"
    CLINICAL = "clinical"
    """Open vocabulary: free-form dictation the grammar cannot cover."""
    FREE = "free"


DIGITS: Final[tuple[str, ...]] = (
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
)

TEENS_AND_TENS: Final[tuple[str, ...]] = (
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
    "thirty",
)

"""Spoken self-correction. These belong in every grammar: a clinician corrects
themselves mid-measurement more often than they change subject."""
CORRECTION_CUES: Final[tuple[str, ...]] = (
    "no",
    "not",
    "sorry",
    "actually",
    "correct",
    "correction",
    "instead",
    "rather",
    "meant",
    "make",
    "that",
    "this",
    "it",
    "to",
)

"""Negation cues.

`free` is deliberately absent even though "free of bleeding" is idiomatic: it is
a near-homophone of "three" and, inside a grammar where both are legal, it wins.
Measured before removal, the utterance "three" came back as "free". The other
cues cover the same meaning without colliding with a digit."""
NEGATION_CUES: Final[tuple[str, ...]] = ("without", "none", "negative", "of", "or", "and")

"""Measurement words.

`pocket` is deliberately absent. It is a near-homophone of `buccal` — both are
two syllables around a medial /k/, differing mainly in the voicing of the initial
plosive — and it won, so a spoken surface change was charted as a measurement
word. "Pocket depth" still reaches the chart: the browser lexicon maps it to
`depth`, which is in the grammar.
"""
MEASUREMENT_WORDS: Final[tuple[str, ...]] = (
    "depth",
    "depths",
    "probing",
    "recession",
    "gingival",
    "margin",
    "attachment",
    "level",
    "millimeters",
    "grade",
    "class",
)

"""Findings.

`pus` and `mobile` are deliberately absent. `mobile` is a near-homophone of
`labial` and won, so naming a surface charted a mobility finding; `mobility` is
the term clinicians use and is in the grammar.

`pus` is deliberately absent. It is short and collides with ordinary speech --
"can you pass me that" was recognized as "pus meant that", which would have
written a suppuration finding out of a request to an assistant. `suppuration` is
the clinical term, is unambiguous, and is in the grammar.
"""
FINDING_WORDS: Final[tuple[str, ...]] = (
    "bleeding",
    "bleeds",
    "blood",
    "suppuration",
    "purulent",
    "exudate",
    "plaque",
    "biofilm",
    "calculus",
    "tartar",
    "mobility",
    "recession",
)

"""Anatomy.

`teeth` is deliberately absent. It adds nothing — clinicians say "tooth
fifteen", and the browser lexicon folds the plural into `tooth` anyway — while
inside the grammar it competed with and won against `skip`, turning "skip" into
"teeth". Removing it downgrades that to a miss, and a miss charts nothing
whereas a substitution charts the wrong thing.
"""
ANATOMY_WORDS: Final[tuple[str, ...]] = (
    "tooth",
    "number",
    "buccal",
    "lingual",
    "palatal",
    "facial",
    "labial",
    "mesial",
    "distal",
    "mid",
    "upper",
    "lower",
    "left",
    "right",
    "quadrant",
    "surface",
)

COMMAND_WORDS: Final[tuple[str, ...]] = (
    "next",
    "back",
    "previous",
    "skip",
    "missing",
    "resume",
    "continue",
    "undo",
    "redo",
    "scratch",
    "strike",
    "clear",
    "reset",
    "confirm",
    "repeat",
    "again",
    "start",
    "over",
    "go",
    "move",
    "on",
    "up",
)

"""Clinical terms the recognizer's lexicon does not contain.

`furcation` is a real gap: the word is absent from the English model and a
grammar containing it would silently never match. It is left out of the grammars
and reaches the chart through the free-form fallback instead. The compound site
names are not a gap in practice — clinicians say them as two words, and both
halves are covered.
"""
KNOWN_LEXICON_GAPS: Final[frozenset[str]] = frozenset({"furcation", "mesiobuccal", "distobuccal"})


def _grammar(*groups: tuple[str, ...]) -> tuple[str, ...]:
    words: list[str] = []
    for group in groups:
        for word in group:
            if word not in words and word not in KNOWN_LEXICON_GAPS:
                words.append(word)
    return tuple(words)


DEPTH_GRAMMAR: Final = _grammar(
    DIGITS, CORRECTION_CUES, MEASUREMENT_WORDS, FINDING_WORDS, NEGATION_CUES
)
TOOTH_GRAMMAR: Final = _grammar(DIGITS, TEENS_AND_TENS, ANATOMY_WORDS, CORRECTION_CUES)
FINDING_GRAMMAR: Final = _grammar(
    FINDING_WORDS, NEGATION_CUES, CORRECTION_CUES, DIGITS, MEASUREMENT_WORDS
)
COMMAND_GRAMMAR: Final = _grammar(
    COMMAND_WORDS, ANATOMY_WORDS, DIGITS, TEENS_AND_TENS, CORRECTION_CUES
)
CLINICAL_GRAMMAR: Final = _grammar(
    DIGITS,
    TEENS_AND_TENS,
    CORRECTION_CUES,
    NEGATION_CUES,
    MEASUREMENT_WORDS,
    FINDING_WORDS,
    ANATOMY_WORDS,
    COMMAND_WORDS,
)

_GRAMMARS: Final[dict[Expectation, tuple[str, ...]]] = {
    Expectation.DEPTHS: CLINICAL_GRAMMAR,
    Expectation.TOOTH: CLINICAL_GRAMMAR,
    Expectation.FINDINGS: CLINICAL_GRAMMAR,
    Expectation.COMMANDS: CLINICAL_GRAMMAR,
    Expectation.CLINICAL: CLINICAL_GRAMMAR,
    Expectation.FREE: CLINICAL_GRAMMAR,
}


def grammar_for(expectation: Expectation) -> tuple[str, ...]:
    """The words the recognizer may emit, plus the out-of-grammar marker.

    Every clinical expectation returns the same grammar on purpose; see the
    module docstring for why narrowing produced substitutions instead of
    refusals. The parameter is kept because routing still reads the expectation
    and because a future grammar could differ without changing callers.
    """
    return (*_GRAMMARS[expectation], UNKNOWN_TOKEN)


def parse_expectation(value: str | None) -> Expectation:
    if value is None:
        return Expectation.CLINICAL
    try:
        return Expectation(value.strip().lower())
    except ValueError:
        return Expectation.CLINICAL


def every_word() -> frozenset[str]:
    """Every word any grammar can emit, for the lexicon coverage gate."""
    words: set[str] = set()
    for grammar in _GRAMMARS.values():
        words.update(grammar)
    return frozenset(words)


def declared_vocabulary() -> frozenset[str]:
    """Everything the product wants to say, including the known gaps.

    The coverage gate compares this against the recognizer lexicon, so a newly
    missing word is a failure rather than a silent omission.
    """
    return frozenset(every_word() | KNOWN_LEXICON_GAPS)
