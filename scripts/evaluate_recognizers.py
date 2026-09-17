"""Compares recognizers on spoken dental phrases.

The project's long-form fixture reported word error rate 0.000 while real
charting worked about a quarter of the time, because it measures continuous
non-clinical speech. This measures the words and the durations the product
actually has to hear.

The result that motivated the grammar recognizer: on these phrases every Whisper
size lands between 23% and 30% exact, and `base.en` scores *below* `tiny.en`, so
accuracy here is not a capacity problem. Constraining the vocabulary is what
moves it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from evaluation.wer import normalize, word_error_rate
from server.config import Settings
from server.grammar_recognizer import VoskGrammarRecognizer
from server.recognizer import FasterWhisperRecognizer
from server.vocabulary import Expectation

FIXTURE = Path("evaluation/fixtures/synthetic-dental")
"""The grammar must beat the open-vocabulary engine by at least this much."""
REQUIRED_ADVANTAGE = 0.25
"""And must clear this on its own, or it is not usable regardless of comparison."""
REQUIRED_EXACT = 0.75


@dataclass(frozen=True, slots=True)
class Score:
    engine: str
    wer: float
    exact: float
    median_ms: float


def load_clip(path: Path, sample_rate: int) -> NDArray[np.float32]:
    with wave.open(str(path), "rb") as handle:
        frames = handle.getnframes()
        source_rate = handle.getframerate()
        raw = np.frombuffer(handle.readframes(frames), dtype="<i2").astype(np.float32) / 32_768.0
    if source_rate == sample_rate:
        return raw
    positions = np.arange(int(len(raw) * sample_rate / source_rate)) * source_rate / sample_rate
    lower = np.clip(np.floor(positions).astype(int), 0, len(raw) - 2)
    fraction = positions - lower
    resampled: NDArray[np.float32] = (
        (1 - fraction) * raw[lower] + fraction * raw[lower + 1]
    ).astype(np.float32)
    return resampled


async def score(
    engine_name: str,
    recognizer: object,
    clips: dict[str, NDArray[np.float32]],
    truth: dict[str, str],
) -> Score:
    wers: list[float] = []
    exact = 0
    times: list[float] = []
    for utterance_id, clip in clips.items():
        started = time.perf_counter()
        result = await recognizer.transcribe(clip, partial=False)  # type: ignore[attr-defined]
        times.append((time.perf_counter() - started) * 1_000)
        wers.append(word_error_rate(truth[utterance_id], result.text))
        if normalize(truth[utterance_id]) == normalize(result.text):
            exact += 1
    return Score(engine_name, float(np.mean(wers)), exact / len(clips), float(np.median(times)))


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gate", action="store_true", help="apply the acceptance thresholds")
    parser.add_argument("--json", type=Path, help="write the scores here")
    arguments = parser.parse_args()

    settings = Settings.from_env()
    truth: dict[str, str] = json.loads((FIXTURE / "truth.json").read_text(encoding="utf-8"))
    clips = {
        utterance_id: load_clip(FIXTURE / "audio" / f"{utterance_id}.wav", settings.sample_rate)
        for utterance_id in truth
    }

    whisper = FasterWhisperRecognizer(settings)
    await whisper.load()
    grammar = VoskGrammarRecognizer(settings)
    await grammar.load()
    grammar.set_expectation(Expectation.CLINICAL)

    scores = [
        await score(f"whisper {settings.model_name}", whisper, clips, truth),
        await score("grammar", grammar, clips, truth),
    ]

    print(
        f"{len(clips)} spoken dental phrases, mean "
        f"{np.mean([c.size / settings.sample_rate for c in clips.values()]):.2f} s\n"
    )
    print(f"{'engine':24s} {'WER':>7s} {'exact':>7s} {'ms/utt':>8s}")
    print("-" * 50)
    for entry in scores:
        exact = f"{entry.exact * 100:.0f}%"
        print(f"{entry.engine:24s} {entry.wer:>7.3f} {exact:>7s} {entry.median_ms:>7.0f}ms")

    if arguments.json:
        arguments.json.write_text(
            json.dumps([entry.__dict__ for entry in scores], indent=2), encoding="utf-8"
        )

    if not arguments.gate:
        return 0

    open_vocab, constrained = scores[0], scores[1]
    problems: list[str] = []
    if constrained.exact < REQUIRED_EXACT:
        problems.append(
            f"grammar recognition reached {constrained.exact:.2f} exact, below the "
            f"{REQUIRED_EXACT:.2f} needed to be usable"
        )
    advantage = constrained.exact - open_vocab.exact
    if advantage < REQUIRED_ADVANTAGE:
        problems.append(
            f"grammar recognition is only {advantage:+.2f} ahead of "
            f"{open_vocab.engine}, below the required {REQUIRED_ADVANTAGE:+.2f}"
        )
    print(f"\nadvantage over open vocabulary: {advantage:+.2f}")
    for problem in problems:
        print(f"FAIL: {problem}")
    print("RECOGNIZER_GATE_PASSED" if not problems else "RECOGNIZER_GATE_FAILED")
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
