"""Verify the live latency contract without weakening the chart-quality bar.

``--unit`` exercises the controls with deterministic in-memory observations and
does not import or load an ASR model. ``--gate`` runs the live socket evaluator,
then reads its versioned JSON report and independently recomputes the chart,
split, coverage, and latency controls. The evaluator's own pass line
(``verify_live_recognizer.py --gate``) decides a different, narrower claim --
project gate G44 (>=90% chart, <=2 false, <=3 split, endpoint->final p95
<=700 ms) -- and is not the oracle for this stricter gate.

The strict contract is intentionally narrower than G44:

* at least 98 of 104 chart cases;
* no more than two false entries and three split recordings;
* endpoint -> final p95 <= 450 ms, over EVERY text final, regardless of how
  it endpointed;
* the semantic hangover (<=200 ms) and composed last-voiced-sample -> final
  p95 (<=650 ms) controls apply ONLY to finals whose endpointReason is
  "semantic". A conversational utterance the clinical grammar cannot
  semantically complete correctly rides out the ordinary silence window
  instead (hundreds of ms) -- that is a correct outcome, not a latency
  defect, and must not be scored against the semantic budgets;
* semantic-reason finals must cover at least 80% of the text finals that
  belong to chartable recordings, so a dead semantic fast path fails
  instead of silently passing on an empty set; and
* a text final missing endpointReason or lastVoiceSample sample evidence
  fails this gate closed.

The silence-endpoint composed last-voice -> final latency is reported
(p50/p95) but never gated: it can legitimately run to the ordinary
trailing-silence window.

The 450 ms allowance is a small hardware margin over the fresh 338 ms p95
reference run and remains around the previously documented 420 ms run. These
are replay/prototype budgets, not clinical performance claims.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
LIVE_EVALUATOR = ROOT / "scripts" / "verify_live_recognizer.py"

# Importing this module loads no ASR model and starts no service; it only
# defines functions/constants (F8), so the pure G44 contract decision can be
# unit-tested without a GPU.
import verify_live_recognizer as _live  # noqa: E402

EXPECTED_MODEL = _live.EXPECTED_MODEL
EXPECTED_DEVICE = _live.EXPECTED_DEVICE
g44_contract_failures = _live.g44_contract_failures
G44_MIN_CHART = _live.GATE_MIN_CHART
G44_MAX_FALSE = _live.GATE_MAX_FALSE
G44_MAX_SPLIT = _live.GATE_MAX_SPLIT
G44_MAX_ENDPOINT_TO_FINAL_P95_MS = _live.GATE_MAX_ENDPOINT_TO_FINAL_P95_MS

MIN_CHART_CASES = 98
MIN_CHART_TOTAL = 104
MAX_FALSE_ENTRIES = 2
MAX_SPLIT_RECORDINGS = 3
MAX_ENDPOINT_TO_FINAL_P95_MS = 450.0
MAX_SEMANTIC_HANGOVER_MS = 200.0
MAX_LAST_VOICE_TO_FINAL_P95_MS = 650.0
# A dead semantic fast path (the grammar never completing early) must fail
# even though every other control could still pass on the silence path.
MIN_SEMANTIC_COVERAGE = 0.80

CHART_RE = re.compile(r"clinical exact match\s+[0-9.]+\s+\((\d+)/(\d+)\)")
FALSE_RE = re.compile(r"false chart entry rate\s+[0-9.]+\s+\((\d+)/(\d+)")


@dataclass(frozen=True)
class Observation:
    """Only the fields this gate is allowed to trust from a live report."""

    model: str
    device: str
    chart_passed: int
    chart_cases: int
    false_entries: int
    split_recordings: int
    text_finals: int
    chartable_text_finals: int
    semantic_text_finals: int
    semantic_chartable_text_finals: int
    finals_with_reason: int
    finals_with_last_voice_sample: int
    matched_endpoint_finals: int
    timed_finals: int
    endpoint_messages: int
    timed_endpoint_messages: int
    endpoint_to_final_ms: tuple[float, ...]
    semantic_hangover_ms: tuple[float, ...]
    semantic_endpoint_to_final_ms: tuple[float, ...]
    last_voice_to_final_ms: tuple[float, ...]
    silence_last_voice_to_final_ms: tuple[float, ...] = ()
    timing_conflicts: int = 0


def percentile(values: tuple[float, ...], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def composed_last_voice_to_final(observation: Observation) -> tuple[float, ...]:
    """Derive the semantic-only composed path from its two raw segments.

    Deliberately recomputed from ``semantic_endpoint_to_final_ms`` and
    ``semantic_hangover_ms`` rather than trusting the reported
    ``last_voice_to_final_ms`` summary directly.
    """
    return tuple(
        endpoint + hangover
        for endpoint, hangover in zip(
            observation.semantic_endpoint_to_final_ms,
            observation.semantic_hangover_ms,
            strict=False,
        )
    )


def _finite_samples(value: object, label: str) -> tuple[float, ...]:
    if not isinstance(value, list):
        raise ValueError(f"liveTiming.{label} must be an array")
    values: list[float] = []
    for index, item in enumerate(value):
        if (
            isinstance(item, bool)
            or not isinstance(item, (int, float))
            or not math.isfinite(float(item))
        ):
            raise ValueError(f"liveTiming.{label}[{index}] must be finite")
        if float(item) < 0:
            raise ValueError(f"liveTiming.{label}[{index}] must be non-negative")
        values.append(float(item))
    return tuple(values)


def _count(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"liveTiming.{label} must be a non-negative integer")
    return value


def parse_observation(report: dict[str, Any], clinical_output: str) -> Observation:
    """Parse a report and recompute controls from raw arrays, not summaries."""
    chart_match = CHART_RE.search(clinical_output)
    false_match = FALSE_RE.search(clinical_output)
    if chart_match is None or false_match is None:
        raise ValueError("clinical evaluator output did not contain chart metrics")

    timing = report.get("liveTiming")
    if not isinstance(timing, dict):
        raise ValueError("liveTiming evidence is absent (older server/evaluator report)")
    endpoint = _finite_samples(timing.get("endpointToFinalMs"), "endpointToFinalMs")
    hangover = _finite_samples(timing.get("semanticHangoverMs"), "semanticHangoverMs")
    semantic_endpoint = _finite_samples(
        timing.get("semanticEndpointToFinalMs"), "semanticEndpointToFinalMs"
    )
    last_voice = _finite_samples(timing.get("lastVoiceToFinalMs"), "lastVoiceToFinalMs")
    silence_last_voice = _finite_samples(
        timing.get("silenceLastVoiceToFinalMs", []), "silenceLastVoiceToFinalMs"
    )
    text_finals = _count(timing.get("textFinals"), "textFinals")
    chartable_text_finals = _count(timing.get("chartableTextFinals"), "chartableTextFinals")
    semantic_text_finals = _count(timing.get("semanticTextFinals"), "semanticTextFinals")
    semantic_chartable_text_finals = _count(
        timing.get("semanticChartableTextFinals"), "semanticChartableTextFinals"
    )
    finals_with_reason = _count(timing.get("finalsWithReason"), "finalsWithReason")
    finals_with_last_voice_sample = _count(
        timing.get("finalsWithLastVoiceSample"), "finalsWithLastVoiceSample"
    )
    matched = _count(timing.get("matchedEndpointFinals"), "matchedEndpointFinals")
    timed = _count(timing.get("timedFinals"), "timedFinals")
    endpoint_messages = _count(timing.get("endpointMessages"), "endpointMessages")
    timed_endpoint_messages = _count(timing.get("timedEndpointMessages"), "timedEndpointMessages")
    conflicts = _count(timing.get("timingConflicts", 0), "timingConflicts")

    results = report.get("results")
    if not isinstance(results, list):
        raise ValueError("live evaluator report has no results array")
    split = 0
    for index, result in enumerate(results):
        if not isinstance(result, dict):
            raise ValueError(f"results[{index}] must be an object")
        finals = result.get("finals")
        if finals is not None:
            if (
                not isinstance(finals, list)
                or not finals
                or any(not isinstance(item, str) for item in finals)
            ):
                raise ValueError(f"results[{index}].finals is malformed")
            if len(finals) > 1:
                split += 1

    return Observation(
        model=str(report.get("model", "")),
        device=str(report.get("device", "")),
        chart_passed=int(chart_match.group(1)),
        chart_cases=int(chart_match.group(2)),
        false_entries=int(false_match.group(1)),
        split_recordings=split,
        text_finals=text_finals,
        chartable_text_finals=chartable_text_finals,
        semantic_text_finals=semantic_text_finals,
        semantic_chartable_text_finals=semantic_chartable_text_finals,
        finals_with_reason=finals_with_reason,
        finals_with_last_voice_sample=finals_with_last_voice_sample,
        matched_endpoint_finals=matched,
        timed_finals=timed,
        endpoint_messages=endpoint_messages,
        timed_endpoint_messages=timed_endpoint_messages,
        endpoint_to_final_ms=endpoint,
        semantic_hangover_ms=hangover,
        semantic_endpoint_to_final_ms=semantic_endpoint,
        last_voice_to_final_ms=last_voice,
        silence_last_voice_to_final_ms=silence_last_voice,
        timing_conflicts=conflicts,
    )


def control_failures(observation: Observation) -> list[str]:
    """Return every failed control; used by both unit and live modes."""
    failures: list[str] = []
    if observation.model != EXPECTED_MODEL or observation.device != EXPECTED_DEVICE:
        failures.append(
            f"engine/device {observation.model!r}/{observation.device!r} "
            f"is not {EXPECTED_MODEL!r}/{EXPECTED_DEVICE!r}"
        )
    if observation.chart_cases < MIN_CHART_TOTAL or observation.chart_passed < MIN_CHART_CASES:
        failures.append(
            f"chart exact {observation.chart_passed}/{observation.chart_cases} "
            f"below {MIN_CHART_CASES}/{MIN_CHART_TOTAL}"
        )
    if observation.false_entries > MAX_FALSE_ENTRIES:
        failures.append(f"false entries {observation.false_entries} above {MAX_FALSE_ENTRIES}")
    if observation.split_recordings > MAX_SPLIT_RECORDINGS:
        failures.append(
            f"split recordings {observation.split_recordings} above {MAX_SPLIT_RECORDINGS}"
        )
    if observation.timing_conflicts:
        failures.append(f"timing conflicts {observation.timing_conflicts}")
    if observation.text_finals <= 0:
        failures.append("no non-empty finals were measured")

    # Coverage/evidence controls over ALL text finals, independent of reason.
    if observation.matched_endpoint_finals != observation.text_finals:
        failures.append(
            f"endpoint evidence covers {observation.matched_endpoint_finals}/"
            f"{observation.text_finals} text finals"
        )
    if observation.timed_finals != observation.text_finals:
        failures.append(
            f"sample timing covers {observation.timed_finals}/{observation.text_finals} text finals"
        )
    if observation.timed_endpoint_messages < observation.text_finals:
        failures.append(
            f"endpoint sample evidence covers {observation.timed_endpoint_messages}/"
            f"{observation.text_finals} text finals"
        )
    if observation.endpoint_messages < observation.text_finals:
        failures.append(
            f"endpoint events cover {observation.endpoint_messages}/"
            f"{observation.text_finals} text finals"
        )
    if observation.timed_endpoint_messages > observation.endpoint_messages:
        failures.append(
            f"timed endpoint events {observation.timed_endpoint_messages} exceed "
            f"endpoint events {observation.endpoint_messages}"
        )
    # F3: a text final missing endpointReason, or missing lastVoiceSample
    # sample evidence, fails this strict gate closed.
    if observation.finals_with_reason != observation.text_finals:
        failures.append(
            f"endpointReason covers {observation.finals_with_reason}/"
            f"{observation.text_finals} text finals"
        )
    if observation.finals_with_last_voice_sample != observation.text_finals:
        failures.append(
            f"lastVoiceSample evidence covers {observation.finals_with_last_voice_sample}/"
            f"{observation.text_finals} text finals"
        )
    # Defensive: the coverage counts must be internally consistent subsets of
    # each other, or the report cannot be trusted to compute coverage from.
    if (
        observation.chartable_text_finals > observation.text_finals
        or observation.semantic_text_finals > observation.text_finals
        or observation.semantic_chartable_text_finals > observation.chartable_text_finals
        or observation.semantic_chartable_text_finals > observation.semantic_text_finals
        or observation.finals_with_reason > observation.text_finals
        or observation.finals_with_last_voice_sample > observation.text_finals
    ):
        failures.append("liveTiming coverage counts are internally inconsistent")

    if not observation.endpoint_to_final_ms:
        failures.append("required endpoint timing evidence is absent")
    if len(observation.endpoint_to_final_ms) != observation.text_finals:
        failures.append(
            f"endpoint latency samples cover {len(observation.endpoint_to_final_ms)}/"
            f"{observation.text_finals} text finals"
        )
    endpoint_p95 = percentile(observation.endpoint_to_final_ms, 0.95)
    if endpoint_p95 > MAX_ENDPOINT_TO_FINAL_P95_MS:
        failures.append(
            f"endpoint-to-final p95 {endpoint_p95:.1f} ms above "
            f"{MAX_ENDPOINT_TO_FINAL_P95_MS:.1f} ms"
        )

    # The hangover/composed controls below, and the semantic-coverage
    # control, apply only to endpointReason == "semantic" finals (F3).
    if observation.chartable_text_finals <= 0:
        failures.append(
            "no chartable text finals were measured; semantic coverage cannot be verified"
        )
    else:
        coverage = observation.semantic_chartable_text_finals / observation.chartable_text_finals
        if coverage < MIN_SEMANTIC_COVERAGE:
            failures.append(
                f"semantic-reason coverage {coverage:.1%} of chartable finals below "
                f"{MIN_SEMANTIC_COVERAGE:.0%}"
            )

    if len(observation.semantic_hangover_ms) != observation.semantic_text_finals:
        failures.append(
            f"hangover samples cover {len(observation.semantic_hangover_ms)}/"
            f"{observation.semantic_text_finals} semantic-reason finals"
        )
    if len(observation.semantic_endpoint_to_final_ms) != observation.semantic_text_finals:
        failures.append(
            f"semantic endpoint-latency samples cover "
            f"{len(observation.semantic_endpoint_to_final_ms)}/"
            f"{observation.semantic_text_finals} semantic-reason finals"
        )
    if len(observation.last_voice_to_final_ms) != observation.semantic_text_finals:
        failures.append(
            f"last-voice samples cover {len(observation.last_voice_to_final_ms)}/"
            f"{observation.semantic_text_finals} semantic-reason finals"
        )
    if (
        len(observation.semantic_endpoint_to_final_ms)
        == len(observation.semantic_hangover_ms)
        == len(observation.last_voice_to_final_ms)
    ):
        composed = tuple(
            endpoint + hangover
            for endpoint, hangover in zip(
                observation.semantic_endpoint_to_final_ms,
                observation.semantic_hangover_ms,
                strict=True,
            )
        )
        mismatches = [
            index
            for index, (expected, reported) in enumerate(
                zip(composed, observation.last_voice_to_final_ms, strict=True)
            )
            if abs(expected - reported) > 1.0
        ]
        if mismatches:
            failures.append(
                "last-voice-to-final samples do not equal semantic endpoint-to-final "
                f"plus hangover at index {mismatches[0]}"
            )
    if observation.semantic_hangover_ms:
        hangover_max = max(observation.semantic_hangover_ms)
        if hangover_max > MAX_SEMANTIC_HANGOVER_MS:
            failures.append(
                f"semantic hangover max {hangover_max:.1f} ms above "
                f"{MAX_SEMANTIC_HANGOVER_MS:.1f} ms"
            )
    composed_last_voice = composed_last_voice_to_final(observation)
    last_voice_p95 = percentile(composed_last_voice, 0.95)
    if last_voice_p95 > MAX_LAST_VOICE_TO_FINAL_P95_MS:
        failures.append(
            f"last-voice-to-final p95 {last_voice_p95:.1f} ms above "
            f"{MAX_LAST_VOICE_TO_FINAL_P95_MS:.1f} ms"
        )
    return failures


def _passing_observation() -> Observation:
    """A 100-text-final replay at the strict boundary on every control.

    80 finals endpoint "semantic" (exactly the 80% coverage floor over 100
    chartable finals); the other 20 ride the silence window and are outside
    every semantic/composed control. Endpoint-to-final p95 (over all 100) and
    the semantic hangover max/composed p95 (over the 80) sit exactly at their
    budgets, so a real regression of even one unit fails.
    """
    endpoint = tuple([320.0] * 90 + [400.0] * 10)  # p95 (index 94) = 400 <= 450
    semantic_endpoint = tuple([320.0] * 72 + [400.0] * 8)  # the 80 semantic finals' component
    hangover = tuple([160.0] * 79 + [200.0] * 1)  # max = 200 <= 200
    last_voice = tuple(e + h for e, h in zip(semantic_endpoint, hangover, strict=True))
    return Observation(
        model=EXPECTED_MODEL,
        device=EXPECTED_DEVICE,
        chart_passed=MIN_CHART_CASES,
        chart_cases=MIN_CHART_TOTAL,
        false_entries=MAX_FALSE_ENTRIES,
        split_recordings=MAX_SPLIT_RECORDINGS,
        text_finals=100,
        chartable_text_finals=100,
        semantic_text_finals=80,
        semantic_chartable_text_finals=80,
        finals_with_reason=100,
        finals_with_last_voice_sample=100,
        matched_endpoint_finals=100,
        timed_finals=100,
        endpoint_messages=100,
        timed_endpoint_messages=100,
        endpoint_to_final_ms=endpoint,
        semantic_hangover_ms=hangover,
        semantic_endpoint_to_final_ms=semantic_endpoint,
        last_voice_to_final_ms=last_voice,
    )


def run_g44_contract_unit() -> None:
    """F8: the G44 decision is a pure function, unit-testable without a GPU.

    A report meeting G44 (90% chart, 700 ms p95) but missing the strict
    contract's numbers (98/104 chart, 450 ms p95) must still pass G44 --
    the whole point of splitting the two gates is that the evaluator's own
    ``--gate`` is looser than ``verify_latency_quality.py --gate``.
    """
    passing = g44_contract_failures(
        model=EXPECTED_MODEL,
        device=EXPECTED_DEVICE,
        chart=G44_MIN_CHART,
        cases=MIN_CHART_TOTAL,
        false_entries=G44_MAX_FALSE,
        split_recordings=G44_MAX_SPLIT,
        endpoint_p95_ms=float(G44_MAX_ENDPOINT_TO_FINAL_P95_MS),
        has_latency_evidence=True,
    )
    if passing:
        raise AssertionError(f"G44 boundary unexpectedly failed: {passing}")
    # This same report would fail the strict contract: 90% < 98/104, and
    # 700 ms > 450 ms. G44 not failing on it is the point of the split.
    strict_chart_ok = G44_MIN_CHART >= MIN_CHART_CASES / MIN_CHART_TOTAL
    strict_p95_ok = G44_MAX_ENDPOINT_TO_FINAL_P95_MS <= MAX_ENDPOINT_TO_FINAL_P95_MS
    if strict_chart_ok or strict_p95_ok:
        raise AssertionError("G44 boundary must be strictly looser than the strict gate's numbers")

    below_chart = g44_contract_failures(
        model=EXPECTED_MODEL,
        device=EXPECTED_DEVICE,
        chart=0.89,
        cases=MIN_CHART_TOTAL,
        false_entries=G44_MAX_FALSE,
        split_recordings=G44_MAX_SPLIT,
        endpoint_p95_ms=float(G44_MAX_ENDPOINT_TO_FINAL_P95_MS),
        has_latency_evidence=True,
    )
    if not below_chart:
        raise AssertionError("G44 did not fail on 89% chart exact")

    over_p95 = g44_contract_failures(
        model=EXPECTED_MODEL,
        device=EXPECTED_DEVICE,
        chart=G44_MIN_CHART,
        cases=MIN_CHART_TOTAL,
        false_entries=G44_MAX_FALSE,
        split_recordings=G44_MAX_SPLIT,
        endpoint_p95_ms=float(G44_MAX_ENDPOINT_TO_FINAL_P95_MS) + 1.0,
        has_latency_evidence=True,
    )
    if not over_p95:
        raise AssertionError("G44 did not fail on 701 ms endpoint p95")

    print(
        "G44 contract unit: PASS boundary "
        f"{G44_MIN_CHART:.0%}/{G44_MAX_ENDPOINT_TO_FINAL_P95_MS:.0f} ms; "
        "FAIL as expected at 89% chart and 701 ms"
    )
    print("G44_CONTRACT_UNIT_PASSED")


def run_unit() -> int:
    """Exercise both a boundary-passing control and independent failures."""
    run_g44_contract_unit()

    passing = _passing_observation()
    if control_failures(passing):
        raise AssertionError(f"passing boundary unexpectedly failed: {control_failures(passing)}")

    negative_controls = {
        "chart": replace(passing, chart_passed=MIN_CHART_CASES - 1),
        "false entries": replace(passing, false_entries=MAX_FALSE_ENTRIES + 1),
        "split": replace(passing, split_recordings=MAX_SPLIT_RECORDINGS + 1),
        "endpoint latency": replace(
            passing,
            endpoint_to_final_ms=tuple([320.0] * 90 + [451.0] * 10),
        ),
        "semantic hangover 201 ms": replace(
            passing,
            semantic_hangover_ms=tuple([160.0] * 79 + [201.0]),
            last_voice_to_final_ms=tuple(
                e + h
                for e, h in zip(
                    passing.semantic_endpoint_to_final_ms,
                    tuple([160.0] * 79 + [201.0]),
                    strict=True,
                )
            ),
        ),
        "composed semantic p95 over 650": replace(
            passing,
            semantic_endpoint_to_final_ms=tuple([500.0] * 80),
            last_voice_to_final_ms=tuple(
                e + h for e, h in zip([500.0] * 80, passing.semantic_hangover_ms, strict=True)
            ),
        ),
        "missing timing": replace(passing, endpoint_to_final_ms=(), semantic_hangover_ms=()),
        "coverage 79%": replace(passing, semantic_chartable_text_finals=79),
        "missing endpointReason": replace(passing, finals_with_reason=99),
        "missing lastVoiceSample": replace(passing, finals_with_last_voice_sample=99),
        "endpoint sample evidence": replace(passing, timed_endpoint_messages=99),
        "engine": replace(passing, device="cpu"),
        "inconsistent coverage counts": replace(passing, semantic_text_finals=200),
    }
    for label, observation in negative_controls.items():
        failures = control_failures(observation)
        if not failures:
            raise AssertionError(f"negative control did not fail: {label}")
        print(f"unit control {label}: FAIL as expected ({failures[0]})")

    # Positive boundary (F3): a long silence-endpoint composed hangover must
    # NOT fail the semantic control -- it is reported, never gated.
    silence_boundary = replace(passing, silence_last_voice_to_final_ms=(5_000.0,))
    silence_failures = control_failures(silence_boundary)
    if silence_failures:
        raise AssertionError(
            f"a long silence-endpoint hangover incorrectly failed a gated control: "
            f"{silence_failures}"
        )
    print("unit control silence hangover 5000 ms: PASS as expected (not gated)")

    print(
        "unit boundary: PASS "
        f"{passing.chart_passed}/{passing.chart_cases}, "
        f"endpoint p95 {percentile(passing.endpoint_to_final_ms, 0.95):.0f} ms, "
        f"hangover max {max(passing.semantic_hangover_ms):.0f} ms, "
        f"semantic coverage "
        f"{passing.semantic_chartable_text_finals}/{passing.chartable_text_finals}"
    )
    print("LATENCY_QUALITY_UNIT_PASSED")
    return 0


def run_live_gate() -> int:
    """Run the real evaluator and apply independent controls to its report."""
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="perio-latency-gate-") as directory:
        report_path = Path(directory) / "live.json"
        completed = subprocess.run(
            [sys.executable, str(LIVE_EVALUATOR), "--gate", "--out", str(report_path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        evaluator_output = completed.stdout + completed.stderr
        print(evaluator_output, end="" if evaluator_output.endswith("\n") else "\n")
        if completed.returncode != 0:
            failures.append(f"live evaluator exited {completed.returncode}")
        if not report_path.is_file():
            failures.append("live evaluator did not write its JSON report")
        else:
            try:
                report = json.loads(report_path.read_text(encoding="utf-8"))
                if not isinstance(report, dict):
                    raise ValueError("report root must be an object")
                clinical = subprocess.run(
                    ["node", "scripts/evaluate-clinical.mjs", "--transcripts", str(report_path)],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                clinical_output = clinical.stdout + clinical.stderr
                print(clinical_output, end="" if clinical_output.endswith("\n") else "\n")
                if clinical.returncode != 0:
                    failures.append(f"independent clinical scoring exited {clinical.returncode}")
                observation = parse_observation(report, clinical_output)
                failures.extend(control_failures(observation))
                coverage = (
                    observation.semantic_chartable_text_finals / observation.chartable_text_finals
                    if observation.chartable_text_finals
                    else 0.0
                )
                print(
                    "independent latency controls: "
                    f"endpoint p95 {percentile(observation.endpoint_to_final_ms, 0.95):.1f} ms "
                    "(all text finals), semantic hangover max "
                    f"{max(observation.semantic_hangover_ms, default=0.0):.1f} ms, "
                    "semantic last-voice p95 "
                    f"{percentile(composed_last_voice_to_final(observation), 0.95):.1f} ms, "
                    f"semantic coverage {coverage:.1%} of chartable finals"
                )
            except (OSError, ValueError, json.JSONDecodeError) as error:
                failures.append(f"could not parse live evidence: {error}")

    if failures:
        for failure in dict.fromkeys(failures):
            print(f"FAIL {failure}")
        print("LATENCY_QUALITY_GATE_FAILED")
        return 1
    print("LATENCY_QUALITY_GATE_PASSED")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--unit", action="store_true", help="run deterministic no-model controls")
    modes.add_argument("--gate", action="store_true", help="run and score the live evaluator")
    arguments = parser.parse_args()
    return run_unit() if arguments.unit else run_live_gate()


if __name__ == "__main__":
    raise SystemExit(main())
