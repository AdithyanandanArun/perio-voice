"""Acoustic replay harness.

Mixes the checked-in speech fixture with synthesized operatory noise at fixed
speech-to-noise ratios, runs the real local recognizer over every mixture, and
reports word error rate per preprocessing profile.

This is the evidence a preprocessing profile is promoted on. The default profile
is deliberately `none`; `--gate` fails if some other profile is measurably better
across the tested bands, which forces the promotion to be a decision someone
makes rather than a default nobody revisited.

The noise is synthesized, not recorded, so these numbers compare profiles
against each other on identical audio. They are not a claim about a specific
clinic; that needs recordings from it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from faster_whisper.audio import decode_audio
from numpy.typing import NDArray

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from evaluation.noise import measured_snr_db, mix_at_snr, synthesize
from evaluation.wer import word_error_rate
from server.config import Settings
from server.denoise import DenoiseProfile, apply_profile
from server.recognizer import FasterWhisperRecognizer, ModelStatus

FIXTURE = Path("tests/fixtures/jfk.flac")
REFERENCE = Path("tests/fixtures/jfk.txt")

NOISE_SOURCES = ("suction", "handpiece", "babble", "hvac")
SNR_BANDS_DB = (15.0, 5.0, 0.0)
"""Fixed seeds, not derived ones: `hash()` is salted per process, so deriving a
seed from the source name would silently test different noise every run and make
the report irreproducible. Two realizations per condition keep one unlucky draw
from deciding a promotion."""
NOISE_SEEDS = (1_129, 7_741)

"""Clean speech must decode this well before any noise result means anything."""
MAX_CLEAN_WER = 0.15
"""A profile has to beat the configured default by this much to be promotable.

One word error on this fixture is 1/22 of its transcript, so a difference smaller
than a few hundredths averaged across the matrix is not evidence of anything.
"""
PROMOTION_MARGIN = 0.03
"""...and must not cost more than this on clean speech, which is the common case."""
CLEAN_REGRESSION_TOLERANCE = 0.03


@dataclass(frozen=True, slots=True)
class Measurement:
    profile: str
    noise: str
    snr_db: float
    seed: int
    measured_snr_db: float
    wer: float
    decode_ms: int


async def measure(
    recognizer: FasterWhisperRecognizer,
    settings: Settings,
    speech: NDArray[np.float32],
    reference: str,
) -> list[Measurement]:
    results: list[Measurement] = []
    for profile in DenoiseProfile:
        clean = apply_profile(speech, settings.sample_rate, profile)
        outcome = await recognizer.transcribe(clean, partial=False)
        results.append(
            Measurement(
                profile.value,
                "clean",
                float("inf"),
                0,
                float("inf"),
                word_error_rate(reference, outcome.text),
                outcome.decode_ms,
            )
        )
        for source in NOISE_SOURCES:
            for seed in NOISE_SEEDS:
                noise = synthesize(source, speech.size, settings.sample_rate, seed=seed)
                for snr in SNR_BANDS_DB:
                    mixture = mix_at_snr(speech, noise, snr)
                    processed = apply_profile(mixture.audio, settings.sample_rate, profile)
                    decoded = await recognizer.transcribe(processed, partial=False)
                    results.append(
                        Measurement(
                            profile.value,
                            source,
                            snr,
                            seed,
                            round(measured_snr_db(speech, mixture), 2),
                            word_error_rate(reference, decoded.text),
                            decoded.decode_ms,
                        )
                    )
    return results


def summarize(results: list[Measurement]) -> dict[str, dict[str, float]]:
    summary: dict[str, dict[str, float]] = {}
    for profile in {result.profile for result in results}:
        rows = [result for result in results if result.profile == profile]
        noisy = [row.wer for row in rows if row.noise != "clean"]
        clean = next(row.wer for row in rows if row.noise == "clean")
        worst_band = [row.wer for row in rows if row.snr_db == min(SNR_BANDS_DB)]
        summary[profile] = {
            "clean_wer": round(clean, 4),
            "mean_noisy_wer": round(sum(noisy) / len(noisy), 4) if noisy else 0.0,
            "worst_band_wer": round(sum(worst_band) / len(worst_band), 4) if worst_band else 0.0,
        }
    return summary


def print_table(results: list[Measurement]) -> None:
    header = (
        f"{'profile':10s} {'noise':10s} {'snr':>6s} {'measured':>9s} {'wer':>7s} {'decode':>8s}"
    )
    print(header)
    print("-" * len(header))
    for result in results:
        snr = "clean" if result.noise == "clean" else f"{result.snr_db:.0f} dB"
        measured = "—" if result.noise == "clean" else f"{result.measured_snr_db:.1f}"
        print(
            f"{result.profile:10s} {result.noise:10s} {snr:>6s} {measured:>9s} "
            f"{result.wer:>7.3f} {result.decode_ms:>6d}ms"
        )


def write_report(
    path: Path,
    model: str,
    configured: str,
    summary: dict[str, dict[str, float]],
    results: list[Measurement],
) -> None:
    path.write_text(
        json.dumps(
            {
                "model": model,
                "configured": configured,
                "summary": summary,
                "measurements": [asdict(result) for result in results],
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def evaluate_gate(
    summary: dict[str, dict[str, float]], configured: str
) -> tuple[bool, list[str], list[str]]:
    problems: list[str] = []
    active = summary[configured]
    if active["clean_wer"] > MAX_CLEAN_WER:
        problems.append(
            f"clean word error rate {active['clean_wer']:.3f} exceeds {MAX_CLEAN_WER:.2f}; "
            "the recognizer is not healthy enough for noise results to mean anything"
        )
    # Negative control: if noise does not degrade recognition, the harness is not
    # measuring what it claims to measure.
    if active["worst_band_wer"] <= active["clean_wer"]:
        problems.append(
            "the worst SNR band did not degrade recognition, so this harness is not "
            "exercising the mixture it reports"
        )
    notes: list[str] = []
    best = min(summary, key=lambda name: summary[name]["mean_noisy_wer"])
    improvement = active["mean_noisy_wer"] - summary[best]["mean_noisy_wer"]
    if best != configured and improvement > PROMOTION_MARGIN:
        regression = summary[best]["clean_wer"] - active["clean_wer"]
        if regression > CLEAN_REGRESSION_TOLERANCE:
            # Clean speech is the common case. A profile that helps at the worst
            # SNR band while damaging clean recognition is not a better default,
            # it is a trade the operator has to make deliberately.
            notes.append(
                f"profile '{best}' lowers mean noisy word error by {improvement:.3f} but "
                f"raises clean word error by {regression:.3f}; kept available, not promoted"
            )
        else:
            problems.append(
                f"profile '{best}' lowers mean noisy word error by {improvement:.3f} over the "
                f"configured '{configured}' with no clean regression; promote it"
            )
    return not problems, problems, notes


def load_inputs() -> tuple[Settings, NDArray[np.float32], str]:
    settings = Settings.from_env()
    speech: NDArray[np.float32] = decode_audio(str(FIXTURE), sampling_rate=settings.sample_rate)
    return settings, speech, REFERENCE.read_text(encoding="utf-8").strip()


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gate", action="store_true", help="apply the acceptance rules")
    parser.add_argument("--json", type=Path, help="write the full measurement set here")
    arguments = parser.parse_args()

    settings, speech, reference = load_inputs()

    recognizer = FasterWhisperRecognizer(settings)
    started = time.perf_counter()
    await recognizer.load()
    if recognizer.status is not ModelStatus.READY:
        print(f"model did not load: {recognizer.error}")
        return 1

    results = await measure(recognizer, settings, speech, reference)
    summary = summarize(results)
    elapsed = time.perf_counter() - started

    print_table(results)
    print()
    print(f"{'profile':10s} {'clean':>8s} {'mean noisy':>11s} {'worst band':>11s}")
    for profile, values in sorted(summary.items()):
        print(
            f"{profile:10s} {values['clean_wer']:>8.3f} {values['mean_noisy_wer']:>11.3f} "
            f"{values['worst_band_wer']:>11.3f}"
        )
    configured = settings.denoise_profile.value
    print(f"\nconfigured profile: {configured}   model: {settings.model_name}   {elapsed:.1f}s")

    if arguments.json:
        write_report(arguments.json, settings.model_name, configured, summary, results)

    if not arguments.gate:
        return 0
    passed, problems, notes = evaluate_gate(summary, configured)
    for note in notes:
        print(f"NOTE: {note}")
    for problem in problems:
        print(f"FAIL: {problem}")
    print("ACOUSTIC_GATE_PASSED" if passed else "ACOUSTIC_GATE_FAILED")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
