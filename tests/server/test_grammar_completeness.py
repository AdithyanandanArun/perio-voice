"""Structural completeness of a grammar partial.

``is_structurally_complete`` decides, from clinical shape alone, whether a
grammar partial already names a whole clinical unit for the active
expectation. It is the piece that lets the fast-path endpoint hint beat
Vosk's own ~500 ms endpointer (F9): Vosk will not call a phrase final until
it sees that much trailing silence, so the hint has to form its own opinion
from the partial text on every frame instead of waiting for Vosk's.

These tests cover every complete and never-complete case named in the task:
depths (exactly three values), tooth (anchor + number), findings (a term,
including negation, and a graded finding's explicit grade), commands (a
whole phrase), and the universal never-complete cases (unknown token, empty
text, FREE expectation).
"""

from __future__ import annotations

from server.vocabulary import Expectation, is_structurally_complete

# ---------------------------------------------------------------------------
# Depths / clinical: exactly three site values.
# ---------------------------------------------------------------------------


def test_depths_three_values_is_complete() -> None:
    assert is_structurally_complete("three four five", Expectation.DEPTHS)


def test_depths_two_values_is_never_complete() -> None:
    assert not is_structurally_complete("three four", Expectation.DEPTHS)


def test_depths_one_value_is_never_complete() -> None:
    assert not is_structurally_complete("three", Expectation.DEPTHS)


def test_depths_four_values_is_not_a_complete_station() -> None:
    # A station is exactly three sites; four values is not "the" three sites,
    # it is a fourth measurement layered on top of a finished one.
    assert not is_structurally_complete("three four five six", Expectation.DEPTHS)


def test_depths_literal_out_of_range_number_still_counts_as_a_value() -> None:
    # Whether "thirteen" is a valid pocket depth is a validation question for
    # commit time (invariant 4), not an endpointing question: the hint only
    # asks whether three values have been spoken.
    assert is_structurally_complete("three thirteen five", Expectation.DEPTHS)


def test_clinical_expectation_also_completes_on_three_depth_values() -> None:
    assert is_structurally_complete("three four five", Expectation.CLINICAL)


# ---------------------------------------------------------------------------
# Tooth: the anchor word plus a tooth number.
# ---------------------------------------------------------------------------


def test_tooth_with_number_is_complete() -> None:
    assert is_structurally_complete("tooth fourteen", Expectation.TOOTH)


def test_tooth_without_number_is_never_complete() -> None:
    assert not is_structurally_complete("tooth", Expectation.TOOTH)


def test_number_without_tooth_anchor_is_never_complete() -> None:
    assert not is_structurally_complete("fourteen", Expectation.TOOTH)


# ---------------------------------------------------------------------------
# Findings: a term alone, its negation, and a graded finding's grade.
# ---------------------------------------------------------------------------


def test_plain_finding_is_complete() -> None:
    assert is_structurally_complete("bleeding", Expectation.FINDINGS)


def test_negated_finding_is_complete() -> None:
    assert is_structurally_complete("no bleeding", Expectation.FINDINGS)


def test_graded_finding_without_grade_is_never_complete() -> None:
    assert not is_structurally_complete("mobility", Expectation.FINDINGS)


def test_graded_finding_with_grade_is_complete() -> None:
    assert is_structurally_complete("mobility two", Expectation.FINDINGS)


def test_negated_graded_finding_needs_no_explicit_grade() -> None:
    # A negated graded finding writes grade 0 (src/domain/negation.ts); the
    # negation cue alone already makes it a whole clinical unit.
    assert is_structurally_complete("no mobility", Expectation.FINDINGS)


# ---------------------------------------------------------------------------
# Commands: a whole phrase, not a bare component word.
# ---------------------------------------------------------------------------


def test_standalone_command_is_complete() -> None:
    assert is_structurally_complete("next", Expectation.COMMANDS)


def test_command_phrase_is_complete() -> None:
    assert is_structurally_complete("start over", Expectation.COMMANDS)


def test_lone_phrase_component_is_never_complete() -> None:
    assert not is_structurally_complete("start", Expectation.COMMANDS)
    assert not is_structurally_complete("over", Expectation.COMMANDS)


# ---------------------------------------------------------------------------
# Universal never-complete cases.
# ---------------------------------------------------------------------------


def test_unknown_token_is_never_complete() -> None:
    assert not is_structurally_complete("three four [unk]", Expectation.DEPTHS)


def test_empty_text_is_never_complete() -> None:
    assert not is_structurally_complete("", Expectation.CLINICAL)


def test_free_expectation_never_completes() -> None:
    # FREE means the grammar could not represent the context at all; nothing
    # it emits can be trusted as a structural clinical unit.
    assert not is_structurally_complete("three four five", Expectation.FREE)


def test_clinical_expectation_completes_on_a_command_too() -> None:
    assert is_structurally_complete("confirm", Expectation.CLINICAL)


def test_clinical_expectation_completes_on_a_finding_too() -> None:
    assert is_structurally_complete("plaque", Expectation.CLINICAL)


def test_depths_expectation_ignores_an_unrelated_command_word() -> None:
    # A command word alone, with no depth values, is not a complete station
    # even though the narrow expectation is DEPTHS.
    assert not is_structurally_complete("next", Expectation.DEPTHS)
