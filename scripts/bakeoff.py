"""Chooses the recognizer on recorded audio, scored by what reaches the chart.

Every engine decodes the same recordings through `evaluate_configuration`, which
emits the exact report `evaluate-clinical.mjs --transcripts` replays through the
real clinical pipeline. Each engine is judged by the chart that results, not by
word error rate, which rewards and punishes formatting ("three" vs "3") that the
chart may or may not care about.

Engines are wrapped to look like a faster-whisper model: `transcribe()` returns
segments carrying `text` and `no_speech_prob`. Nothing in scoring knows which
engine produced a transcript.

    uv run --extra gpu --with sherpa-onnx python scripts/bakeoff.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import statistics
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from evaluate_dental import (  # noqa: E402
    RuntimeConfig,
    discover_audio,
    evaluate_configuration,
    load_manifest,
)

from evaluation.wer import normalize  # noqa: E402

MANIFEST = Path("evaluation/fixtures/dental/phrases.json")
REPLAY_ROOT = Path("evaluation/fixtures/dental/audio/tts-replay")
MODELS = Path("models")
PARAKEET_DIR = MODELS / "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"


@dataclass
class Segment:
    """The fields evaluate_dental reads from a faster-whisper segment."""

    text: str
    no_speech_prob: float = 0.0
    avg_logprob: float = 0.0
    start: float = 0.0
    end: float = 1.0


class VoskModel:
    """Today's grammar recognizer behind the faster-whisper call shape."""

    def __init__(self) -> None:
        from server.config import Settings
        from server.grammar_recognizer import VoskGrammarRecognizer
        from server.vocabulary import Expectation

        self._recognizer = VoskGrammarRecognizer(Settings.from_env())
        asyncio.run(self._recognizer.load())
        self._recognizer.set_expectation(Expectation.CLINICAL)

    def transcribe(self, audio: Any, **_: Any) -> tuple[Iterator[Segment], None]:
        result = asyncio.run(self._recognizer.transcribe(audio, partial=False))
        return iter([Segment(result.text)]), None


class ParakeetModel:
    """NVIDIA Parakeet-TDT 0.6B through sherpa-onnx, CPU int8."""

    def __init__(self) -> None:
        import sherpa_onnx

        self._recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(PARAKEET_DIR / "encoder.int8.onnx"),
            decoder=str(PARAKEET_DIR / "decoder.int8.onnx"),
            joiner=str(PARAKEET_DIR / "joiner.int8.onnx"),
            tokens=str(PARAKEET_DIR / "tokens.txt"),
            num_threads=8,
            model_type="nemo_transducer",
            decoding_method="greedy_search",
        )

    def transcribe(self, audio: Any, **_: Any) -> tuple[Iterator[Segment], None]:
        stream = self._recognizer.create_stream()
        stream.accept_waveform(16_000, audio)
        self._recognizer.decode_stream(stream)
        return iter([Segment(stream.result.text.strip())]), None


def whisper_factory(config: RuntimeConfig) -> Any:
    from faster_whisper import WhisperModel

    if config.device == "cuda":
        from server.cuda_runtime import ensure_cuda_libraries

        ensure_cuda_libraries()
    return WhisperModel(
        config.model,
        device=config.device,
        compute_type=config.compute_type,
        download_root=str(config.model_dir),
    )


"""A prompt written as example transcriptions rather than a description.

Large Whisper models imitate the style of their prompt as well as its
vocabulary, so this primes both: clinical terms the model would otherwise
replace with common English, and digits spelled out as words -- the form the
chart reads -- instead of formatted numerals."""
EXAMPLE_PROMPT = (
    "three four five. two three four. four. bleeding. no bleeding. suppuration. "
    "plaque. calculus. tooth fifteen buccal. lingual. palatal. mesial buccal four. "
    "furcation class two. mobility one. recession two. four no three. repeat that. "
    "next tooth. skip this tooth. undo that."
)


"""The example prompt extended with the phrasings the replay recordings showed
it getting wrong. Priming "tooth" turned "correct that to three" into "correct
that tooth. three" -- a navigation to tooth three instead of a correction -- and
"depths three four five" into "next three four five", a workflow command. Each
is added here in the exact form the chart expects."""
EXAMPLE_PROMPT_2 = (
    "three four five. depths three four five. two three four. three. four. five. "
    "four no three. correct that to three. repeat that three four four. bleeding. "
    "no bleeding. suppuration. plaque and calculus. b o p. p d three four five. "
    "tooth fifteen. buccal. lingual. palatal. mesial buccal four. furcation class "
    "two. mobility grade three. recession two. next tooth. skip this tooth. "
    "resume. undo that."
)


class SpeechGated:
    """Applies the service's speech checks around a whole-recording decode.

    The service refuses a segment that is saturated or that Silero does not hear
    as speech before decoding, and a final whose no-speech estimate exceeds the
    threshold after. Scoring the shipped recognizer without them would measure a
    configuration that does not run.
    """

    def __init__(self, inner: Any, presence_threshold: float, no_speech_threshold: float) -> None:
        self.inner = inner
        self.presence_threshold = presence_threshold
        self.no_speech_threshold = no_speech_threshold

    def transcribe(self, audio: Any, **options: Any) -> tuple[Iterator[Any], Any]:
        from server.speech_presence import assess

        if not assess(audio).is_speech(self.presence_threshold):
            return iter(()), None
        segments, info = self.inner.transcribe(audio, **options)
        materialized = list(segments)
        no_speech = max((float(s.no_speech_prob) for s in materialized), default=0.0)
        if no_speech > self.no_speech_threshold:
            return iter(()), info
        return iter(materialized), info


def gated(config: RuntimeConfig) -> Any:
    from server.config import GPU_NO_SPEECH_THRESHOLD, GPU_SPEECH_PRESENCE_THRESHOLD

    return SpeechGated(
        whisper_factory(config), GPU_SPEECH_PRESENCE_THRESHOLD, GPU_NO_SPEECH_THRESHOLD
    )


class PromptedModel:
    """Adds decoding options to every transcribe call of a wrapped model."""

    def __init__(self, inner: Any, **options: Any) -> None:
        self._inner = inner
        self._options = options

    def transcribe(self, audio: Any, **options: Any) -> Any:
        return self._inner.transcribe(audio, **{**options, **self._options})


def prompted(**options: Any) -> Callable[[RuntimeConfig], Any]:
    def factory(config: RuntimeConfig) -> Any:
        return PromptedModel(whisper_factory(config), **options)

    return factory


@dataclass(frozen=True)
class Candidate:
    name: str
    config: RuntimeConfig
    factory: Callable[[RuntimeConfig], Any]


def _config(
    model: str, device: str, compute: str, beam: int = 5, bias: str = "off"
) -> RuntimeConfig:
    return RuntimeConfig(
        model=model,
        device=device,
        compute_type=compute,
        beam_size=beam,
        bias_mode=bias,  # type: ignore[arg-type]
        language="en",
        model_dir=MODELS,
    )


CANDIDATES: dict[str, Candidate] = {
    "grammar": Candidate(
        "grammar", _config("vosk-lgraph-grammar", "cpu", "grammar"), lambda _: VoskModel()
    ),
    "tiny.en": Candidate("tiny.en", _config("tiny.en", "cpu", "int8"), whisper_factory),
    "parakeet": Candidate(
        "parakeet", _config("parakeet-tdt-0.6b-v2", "cpu", "int8"), lambda _: ParakeetModel()
    ),
    "distil-large-v3": Candidate(
        "distil-large-v3", _config("distil-large-v3", "cuda", "float16"), whisper_factory
    ),
    "large-v3-turbo": Candidate(
        "large-v3-turbo", _config("large-v3-turbo", "cuda", "float16"), whisper_factory
    ),
    "large-v3": Candidate("large-v3", _config("large-v3", "cuda", "float16"), whisper_factory),
    "turbo+describe": Candidate(
        "turbo+describe",
        _config("large-v3-turbo", "cuda", "float16"),
        lambda config: prompted(initial_prompt=_describe_prompt())(config),
    ),
    "turbo+examples": Candidate(
        "turbo+examples",
        _config("large-v3-turbo", "cuda", "float16"),
        prompted(initial_prompt=EXAMPLE_PROMPT),
    ),
    "turbo+examples2": Candidate(
        "turbo+examples2",
        _config("large-v3-turbo", "cuda", "float16"),
        prompted(initial_prompt=EXAMPLE_PROMPT_2),
    ),
    "large-v3+examples2": Candidate(
        "large-v3+examples2",
        _config("large-v3", "cuda", "float16"),
        prompted(initial_prompt=EXAMPLE_PROMPT_2),
    ),
    "distil+examples2": Candidate(
        "distil+examples2",
        _config("distil-large-v3", "cuda", "float16"),
        prompted(initial_prompt=EXAMPLE_PROMPT_2),
    ),
    # The shipped configuration: the prompt read from shared/dental-prompt.json
    # through the same bias path the live recognizer uses, and the service's
    # speech checks, so what is measured here is exactly what runs.
    "shipped": Candidate(
        "shipped",
        _config("large-v3", "cuda", "float16", bias="prompt"),
        gated,
    ),
    # The same without the speech checks, to show what they cost.
    "shipped-ungated": Candidate(
        "shipped-ungated",
        _config("large-v3", "cuda", "float16", bias="prompt"),
        whisper_factory,
    ),
    # Same model and prompt, decoded with the options the live recognizer uses for
    # finals: word timestamps on, which forces timestamp tokens into the decode.
    "shipped-live": Candidate(
        "shipped-live",
        _config("large-v3", "cuda", "float16", bias="prompt"),
        lambda config: PromptedModel(
            whisper_factory(config), word_timestamps=True, without_timestamps=False
        ),
    ),
    "turbo+hotwords": Candidate(
        "turbo+hotwords",
        _config("large-v3-turbo", "cuda", "float16"),
        prompted(hotwords=EXAMPLE_PROMPT),
    ),
}


def _describe_prompt() -> str:
    from server.prompt import dental_prompt

    return dental_prompt()


CHART_LINE = re.compile(r"clinical exact match\s+([0-9.]+)\s+\((\d+)/(\d+)\)")
FALSE_LINE = re.compile(r"false chart entry rate\s+([0-9.]+)\s+\((\d+)/(\d+)")


def chart_score(transcripts: Path) -> tuple[float, int, int, int, int]:
    """Replays transcripts through the real clinical pipeline."""
    completed = subprocess.run(
        ["node", "scripts/evaluate-clinical.mjs", "--transcripts", str(transcripts)],
        capture_output=True,
        text=True,
        check=False,
    )
    output = completed.stdout + completed.stderr
    chart = CHART_LINE.search(output)
    false = FALSE_LINE.search(output)
    if chart is None or false is None:
        raise RuntimeError(f"could not read chart metrics:\n{output[-2000:]}")
    return (
        float(chart.group(1)),
        int(chart.group(2)),
        int(chart.group(3)),
        int(false.group(2)),
        int(false.group(3)),
    )


def run(
    names: list[str], audio_root: Path, out_dir: Path, *, allow_missing: bool = True
) -> list[dict[str, object]]:
    manifest = load_manifest(MANIFEST)
    inventory = discover_audio(manifest, audio_root)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, object]] = []
    for name in names:
        candidate = CANDIDATES[name]
        started = time.perf_counter()
        payload = evaluate_configuration(
            manifest,
            MANIFEST,
            audio_root,
            inventory,
            candidate.config,
            allow_missing=allow_missing,
            model_factory=candidate.factory,
        )
        elapsed = time.perf_counter() - started
        path = out_dir / f"{name}.json"
        path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        results = payload["results"]
        assert isinstance(results, list)
        words = sum(
            1 for item in results if normalize(item["reference"]) == normalize(item["transcript"])
        )
        decode = sorted(int(item["decodeMs"]) for item in results)
        chart, passed, cases, false, nonchart = chart_score(path)
        row: dict[str, object] = {
            "engine": name,
            "recordings": len(results),
            "wordExact": words / max(1, len(results)),
            "chartExact": chart,
            "chartPassed": passed,
            "chartCases": cases,
            "falseEntries": false,
            "nonChartable": nonchart,
            "decodeP50": statistics.median(decode) if decode else 0,
            "decodeP95": decode[max(0, math.ceil(len(decode) * 0.95) - 1)] if decode else 0,
            "seconds": round(elapsed, 1),
        }
        rows.append(row)
        print(
            f"{name:16s} chart {chart:6.1%} ({passed}/{cases})  false {false}/{nonchart}  "
            f"words {words / max(1, len(results)):6.1%}  p50 {row['decodeP50']:>5}ms  "
            f"p95 {row['decodeP95']:>5}ms",
            flush=True,
        )
    return rows


def rescore(out_dir: Path) -> list[dict[str, object]]:
    """Re-runs chart scoring on saved transcripts without decoding anything.

    Scoring replays transcripts through the current clinical pipeline, so a change
    to the lexicon or the lattice can be measured against every engine in seconds
    instead of re-decoding every recording.
    """
    rows: list[dict[str, object]] = []
    for path in sorted(out_dir.glob("*.json")):
        if path.name == "summary.json":
            continue
        chart, passed, cases, false, nonchart = chart_score(path)
        row: dict[str, object] = {
            "engine": path.stem,
            "chartExact": chart,
            "chartPassed": passed,
            "chartCases": cases,
            "falseEntries": false,
            "nonChartable": nonchart,
        }
        rows.append(row)
        print(f"{path.stem:16s} chart {chart:6.1%} ({passed}/{cases})  false {false}/{nonchart}")
    return rows


# The acceptance bar for the recognizer the service ships. Measured at 94.2%
# (98/104) with 1/28 false entries and p95 367 ms when it was adopted; the bar
# sits below that because one scenario is ~1 point and differences of one or two
# are noise on this set. The margin is over the recognizer it replaced.
GATE_ENGINE = "shipped"
GATE_BASELINE = "grammar"
GATE_MIN_CHART = 0.90
GATE_MAX_FALSE = 2
GATE_MIN_MARGIN = 0.25
GATE_MAX_P95_MS = 700


def _number(row: dict[str, object], key: str) -> float:
    value = row[key]
    if not isinstance(value, int | float):
        raise TypeError(f"{key} is not numeric: {value!r}")
    return float(value)


def gate(engine: str, audio_root: Path, out_dir: Path) -> int:
    """Decides whether `engine` is good enough to be the one the service runs.

    Every recording in the manifest must be present, so a partial capture cannot
    pass on an easy subset. The replay recordings are one synthetic voice through
    the laptop speakers: passing establishes that the recognizer and prompt work
    through a real microphone path, not that clinicians will see the same number.
    """
    rows = run([engine, GATE_BASELINE], audio_root, out_dir, allow_missing=False)
    chosen, baseline = rows
    failures: list[str] = []
    chart = _number(chosen, "chartExact")
    margin = chart - _number(baseline, "chartExact")
    false = int(_number(chosen, "falseEntries"))
    p95 = int(_number(chosen, "decodeP95"))
    if chart < GATE_MIN_CHART:
        failures.append(f"chart exact {chart:.1%} below {GATE_MIN_CHART:.0%}")
    if false > GATE_MAX_FALSE:
        failures.append(f"{false} false chart entries, at most {GATE_MAX_FALSE} allowed")
    if margin < GATE_MIN_MARGIN:
        failures.append(f"margin over {GATE_BASELINE} {margin:+.1%} below {GATE_MIN_MARGIN:+.0%}")
    if p95 > GATE_MAX_P95_MS:
        failures.append(f"decode p95 {p95} ms above {GATE_MAX_P95_MS} ms")
    for failure in failures:
        print(f"FAIL {failure}")
    if failures:
        return 1
    print(
        f"BAKEOFF GATE PASS {engine}: chart {chart:.1%}, false {false}, "
        f"margin {margin:+.1%} over {GATE_BASELINE}, p95 {p95} ms"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rescore", action="store_true", help="score saved transcripts only")
    parser.add_argument("--engines", default=",".join(CANDIDATES), help="comma-separated")
    parser.add_argument("--audio-root", type=Path, default=REPLAY_ROOT)
    parser.add_argument("--out-dir", type=Path, default=Path("evaluation/results/bakeoff"))
    parser.add_argument("--gate", action="store_true", help="decide the shipped recognizer")
    parser.add_argument("--gate-engine", default=GATE_ENGINE, help="engine the gate judges")
    arguments = parser.parse_args()
    if arguments.gate:
        if arguments.gate_engine not in CANDIDATES:
            parser.error(f"unknown engine: {arguments.gate_engine}")
        return gate(arguments.gate_engine, arguments.audio_root, arguments.out_dir)
    if arguments.rescore:
        rescore(arguments.out_dir)
        return 0
    names = [name.strip() for name in arguments.engines.split(",") if name.strip()]
    unknown = [name for name in names if name not in CANDIDATES]
    if unknown:
        parser.error(f"unknown engines: {', '.join(unknown)}")
    rows = run(names, arguments.audio_root, arguments.out_dir)
    (arguments.out_dir / "summary.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
