"""Word error rate, the acoustic-tier metric.

Word error rate answers "did the recognizer hear the words?" and nothing more.
It is reported separately from the clinical metrics on purpose: a transcript can
be word-perfect and still produce a wrong chart, and a transcript with errors can
still produce a correct one once the clinical layer has resolved it. Conflating
them hides which half of the system moved.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_PUNCTUATION = re.compile(r"[^a-z0-9'\s]")


def normalize(text: str) -> list[str]:
    folded = _PUNCTUATION.sub(" ", text.casefold())
    return [token for token in folded.split() if token]


@dataclass(frozen=True, slots=True)
class ErrorCounts:
    substitutions: int
    deletions: int
    insertions: int
    reference_words: int

    @property
    def errors(self) -> int:
        return self.substitutions + self.deletions + self.insertions

    @property
    def rate(self) -> float:
        if self.reference_words == 0:
            return 0.0 if self.insertions == 0 else 1.0
        return self.errors / self.reference_words


def align(reference: list[str], hypothesis: list[str]) -> ErrorCounts:
    """Levenshtein alignment with the edit types kept separate."""
    rows, columns = len(reference) + 1, len(hypothesis) + 1
    distance = [[0] * columns for _ in range(rows)]
    backtrace = [[""] * columns for _ in range(rows)]
    for row in range(1, rows):
        distance[row][0] = row
        backtrace[row][0] = "D"
    for column in range(1, columns):
        distance[0][column] = column
        backtrace[0][column] = "I"
    for row in range(1, rows):
        for column in range(1, columns):
            match = reference[row - 1] == hypothesis[column - 1]
            options = (
                (distance[row - 1][column - 1] + (0 if match else 1), "M" if match else "S"),
                (distance[row - 1][column] + 1, "D"),
                (distance[row][column - 1] + 1, "I"),
            )
            distance[row][column], backtrace[row][column] = min(options, key=lambda item: item[0])

    substitutions = deletions = insertions = 0
    row, column = len(reference), len(hypothesis)
    while row > 0 or column > 0:
        operation = backtrace[row][column]
        if operation in {"M", "S"}:
            substitutions += 1 if operation == "S" else 0
            row -= 1
            column -= 1
        elif operation == "D":
            deletions += 1
            row -= 1
        else:
            insertions += 1
            column -= 1
    return ErrorCounts(substitutions, deletions, insertions, len(reference))


def word_error_rate(reference: str, hypothesis: str) -> float:
    return align(normalize(reference), normalize(hypothesis)).rate
