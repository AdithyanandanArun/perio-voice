"""Decode the private dental fixture and emit an auditable transcript report.

The checked-in manifest is the source of truth.  Voice recordings remain local,
but every expected ``quiet``/``noise`` recording is inventoried before a model is
loaded.  The resulting JSON is deliberately self-contained so the Node clinical
evaluator can replay the recognized words without needing access to voice data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import wave
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol, cast

import numpy as np
from numpy.typing import NDArray

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from evaluation.wer import align, normalize, word_error_rate  # noqa: E402
from server.config import Settings  # noqa: E402
from server.prompt import dental_prompt, prompt_version  # noqa: E402

DEFAULT_MANIFEST = Path("evaluation/fixtures/dental/phrases.json")
TRANSCRIPT_SCHEMA_VERSION = 1
REQUIRED_SAMPLE_RATE = 16_000
REQUIRED_PASSES = ("quiet", "noise")
CLINICAL_COHORTS = frozenset(
    {
        "accent",
        "ambiguity",
        "clean",
        "context",
        "conversational",
        "corrections",
        "multispeaker",
        "negation",
        "rapid",
        "sequence",
        "terminology",
    }
)
SWEEP_MODELS = ("tiny.en", "base.en", "small.en")
SWEEP_BEAMS = (1, 5)
SWEEP_BIASES = ("off", "prompt", "hotwords")

BiasMode = Literal["off", "prompt", "hotwords"]
FloatAudio = NDArray[np.float32]


class DentalEvaluationError(ValueError):
    """A user-actionable fixture or evaluation error."""


class ManifestError(DentalEvaluationError):
    """The checked-in fixture manifest does not satisfy its public contract."""


class AudioInventoryError(DentalEvaluationError):
    """Local fixture audio is ambiguous or invalid."""


@dataclass(frozen=True, slots=True)
class DentalUtterance:
    id: str
    prompt: str
    chartable: bool

    def as_json(self) -> dict[str, object]:
        return {"id": self.id, "prompt": self.prompt, "chartable": self.chartable}


@dataclass(frozen=True, slots=True)
class DentalScenario:
    id: str
    cohort: str
    utterances: tuple[DentalUtterance, ...]
    expect: dict[str, object]
    start: dict[str, object] | None
    settings: dict[str, object] | None

    def as_json(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": self.id,
            "cohort": self.cohort,
            "utterances": [utterance.as_json() for utterance in self.utterances],
            "expect": self.expect,
        }
        if self.start is not None:
            payload["start"] = self.start
        if self.settings is not None:
            payload["settings"] = self.settings
        return payload


@dataclass(frozen=True, slots=True)
class DentalManifest:
    schema_version: str | int
    fixture_version: str | int
    sample_rate: int
    passes: tuple[str, ...]
    scenarios: tuple[DentalScenario, ...]

    @property
    def utterance_count(self) -> int:
        return sum(len(scenario.utterances) for scenario in self.scenarios)

    def fixture_json(self, manifest_path: Path, audio_root: Path) -> dict[str, object]:
        return {
            "schemaVersion": self.schema_version,
            "fixtureVersion": self.fixture_version,
            "sampleRate": self.sample_rate,
            "passes": list(self.passes),
            "manifest": manifest_path.as_posix(),
            "audioRoot": audio_root.as_posix(),
            "scenarioCount": len(self.scenarios),
            "utteranceCount": self.utterance_count,
        }


@dataclass(frozen=True, slots=True)
class AudioKey:
    pass_id: str
    scenario_id: str
    cohort: str
    utterance_id: str
    reference: str
    chartable: bool

    def identity(self) -> tuple[str, str]:
        return self.pass_id, self.utterance_id

    def missing_json(self) -> dict[str, object]:
        return {
            "pass": self.pass_id,
            "scenarioId": self.scenario_id,
            "utteranceId": self.utterance_id,
            "expectedPath": f"{self.pass_id}/{self.utterance_id}.wav",
        }


@dataclass(frozen=True, slots=True)
class AudioInventory:
    expected: tuple[AudioKey, ...]
    files: dict[tuple[str, str], Path]
    missing: tuple[AudioKey, ...]
    extra: tuple[Path, ...]

    @property
    def complete(self) -> bool:
        return not self.missing


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    model: str
    device: str
    compute_type: str
    beam_size: int
    bias_mode: BiasMode
    language: str
    model_dir: Path

    def __post_init__(self) -> None:
        if not self.model.strip():
            raise DentalEvaluationError("model must be non-empty")
        if not self.device.strip():
            raise DentalEvaluationError("device must be non-empty")
        if not self.compute_type.strip():
            raise DentalEvaluationError("compute type must be non-empty")
        if self.beam_size < 1:
            raise DentalEvaluationError("beam size must be at least 1")

    @property
    def id(self) -> str:
        return f"{self.model}-beam{self.beam_size}-{self.bias_mode}"

    def as_json(self) -> dict[str, object]:
        prompt = dental_prompt()
        enabled = self.bias_mode != "off"
        return {
            "id": self.id,
            "backend": "faster-whisper",
            "model": self.model,
            "device": self.device,
            "computeType": self.compute_type,
            "beamSize": self.beam_size,
            "language": self.language,
            "bias": {
                "mode": self.bias_mode,
                "enabled": enabled,
                "promptVersion": prompt_version() if enabled else None,
                "promptSha256": (
                    hashlib.sha256(prompt.encode("utf-8")).hexdigest() if enabled else None
                ),
            },
        }


class SegmentLike(Protocol):
    text: str
    start: float
    end: float
    no_speech_prob: float
    avg_logprob: float


class WhisperModelLike(Protocol):
    def transcribe(
        self, audio: FloatAudio, **options: object
    ) -> tuple[Iterable[SegmentLike], object]: ...


ModelFactory = Callable[[RuntimeConfig], WhisperModelLike]
AudioDecoder = Callable[[Path, int], FloatAudio]


def _object(value: object, location: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ManifestError(f"{location} must be an object")
    if not all(isinstance(key, str) for key in value):
        raise ManifestError(f"{location} must use string keys")
    return cast(dict[str, object], value)


def _non_empty_string(value: object, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{location} must be a non-empty string")
    return value


def _version(value: object, location: str) -> str | int:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ManifestError(f"{location} must be a string or integer")
    if isinstance(value, str) and not value.strip():
        raise ManifestError(f"{location} must be non-empty")
    return value


def _filesystem_safe_id(value: object, location: str) -> str:
    identifier = _non_empty_string(value, location)
    if identifier in {".", ".."} or any(
        not (character.isascii() and (character.isalnum() or character in "._-"))
        for character in identifier
    ):
        raise ManifestError(
            f"{location} must contain only ASCII letters, digits, dot, underscore, or hyphen"
        )
    if not identifier[0].isalnum():
        raise ManifestError(f"{location} must start with a letter or digit")
    return identifier


def load_manifest(path: Path) -> DentalManifest:
    """Load and validate every field used by capture, decoding, or replay."""
    try:
        loaded: object = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ManifestError(f"fixture manifest does not exist: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ManifestError(
            f"fixture manifest is not valid JSON: {path}:{exc.lineno}:{exc.colno}"
        ) from exc

    root = _object(loaded, "manifest")
    schema_version = _version(root.get("schemaVersion"), "manifest.schemaVersion")
    fixture_version = _version(root.get("fixtureVersion"), "manifest.fixtureVersion")
    sample_rate = root.get("sampleRate")
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int):
        raise ManifestError("manifest.sampleRate must be an integer")
    if sample_rate != REQUIRED_SAMPLE_RATE:
        raise ManifestError(
            f"manifest.sampleRate must be {REQUIRED_SAMPLE_RATE}, got {sample_rate}"
        )

    raw_passes = root.get("passes")
    if not isinstance(raw_passes, list) or not all(isinstance(item, str) for item in raw_passes):
        raise ManifestError("manifest.passes must be an array of strings")
    passes = tuple(cast(list[str], raw_passes))
    if len(passes) != len(set(passes)):
        raise ManifestError("manifest.passes contains a duplicate pass id")
    if set(passes) != set(REQUIRED_PASSES):
        raise ManifestError("manifest.passes must contain exactly 'quiet' and 'noise'")

    raw_scenarios = root.get("scenarios")
    if not isinstance(raw_scenarios, list) or not raw_scenarios:
        raise ManifestError("manifest.scenarios must be a non-empty array")

    scenario_ids: set[str] = set()
    utterance_ids: set[str] = set()
    scenarios: list[DentalScenario] = []
    for scenario_index, raw_scenario in enumerate(raw_scenarios):
        location = f"manifest.scenarios[{scenario_index}]"
        scenario = _object(raw_scenario, location)
        scenario_id = _non_empty_string(scenario.get("id"), f"{location}.id")
        if scenario_id in scenario_ids:
            raise ManifestError(f"duplicate scenario id: {scenario_id}")
        scenario_ids.add(scenario_id)

        cohort = _non_empty_string(scenario.get("cohort"), f"{location}.cohort")
        if cohort not in CLINICAL_COHORTS:
            raise ManifestError(f"{location}.cohort is not a clinical corpus cohort: {cohort}")

        raw_utterances = scenario.get("utterances")
        if not isinstance(raw_utterances, list) or not raw_utterances:
            raise ManifestError(f"{location}.utterances must be a non-empty array")
        utterances: list[DentalUtterance] = []
        for utterance_index, raw_utterance in enumerate(raw_utterances):
            utterance_location = f"{location}.utterances[{utterance_index}]"
            utterance = _object(raw_utterance, utterance_location)
            utterance_id = _filesystem_safe_id(utterance.get("id"), f"{utterance_location}.id")
            if utterance_id in utterance_ids:
                raise ManifestError(f"duplicate global utterance id: {utterance_id}")
            utterance_ids.add(utterance_id)
            prompt = _non_empty_string(utterance.get("prompt"), f"{utterance_location}.prompt")
            chartable_value = utterance.get("chartable", True)
            if not isinstance(chartable_value, bool):
                raise ManifestError(f"{utterance_location}.chartable must be a boolean")
            utterances.append(DentalUtterance(utterance_id, prompt, chartable_value))

        expect = _object(scenario.get("expect"), f"{location}.expect")
        start_value = scenario.get("start")
        settings_value = scenario.get("settings")
        start = None if start_value is None else _object(start_value, f"{location}.start")
        settings = (
            None if settings_value is None else _object(settings_value, f"{location}.settings")
        )
        scenarios.append(
            DentalScenario(
                scenario_id,
                cohort,
                tuple(utterances),
                expect,
                start,
                settings,
            )
        )

    return DentalManifest(
        schema_version,
        fixture_version,
        sample_rate,
        passes,
        tuple(scenarios),
    )


def expected_audio(manifest: DentalManifest) -> tuple[AudioKey, ...]:
    return tuple(
        AudioKey(
            pass_id,
            scenario.id,
            scenario.cohort,
            utterance.id,
            utterance.prompt,
            utterance.chartable,
        )
        for pass_id in manifest.passes
        for scenario in manifest.scenarios
        for utterance in scenario.utterances
    )


def _match_audio_path(
    relative: Path,
    passes: set[str],
    utterance_ids: set[str],
) -> tuple[str, str] | None:
    stem = relative.stem
    parent_passes = [part for part in relative.parts[:-1] if part in passes]
    if stem in utterance_ids and len(parent_passes) == 1:
        return parent_passes[0], stem
    if stem in utterance_ids and len(parent_passes) > 1:
        raise AudioInventoryError(f"audio path contains multiple fixture passes: {relative}")

    matches: set[tuple[str, str]] = set()
    for pass_id in passes:
        for utterance_id in utterance_ids:
            if stem in {
                f"{utterance_id}-{pass_id}",
                f"{utterance_id}.{pass_id}",
                f"{pass_id}-{utterance_id}",
                f"{pass_id}.{utterance_id}",
            }:
                matches.add((pass_id, utterance_id))
    if len(matches) > 1:
        raise AudioInventoryError(f"audio filename is ambiguous: {relative}")
    return next(iter(matches)) if matches else None


def discover_audio(manifest: DentalManifest, audio_root: Path) -> AudioInventory:
    """Match local WAVs by manifest id without silently accepting unknown audio."""
    expected = expected_audio(manifest)
    passes = set(manifest.passes)
    utterance_ids = {key.utterance_id for key in expected}
    files: dict[tuple[str, str], Path] = {}
    extra: list[Path] = []

    if audio_root.exists() and not audio_root.is_dir():
        raise AudioInventoryError(f"audio root is not a directory: {audio_root}")
    candidates = (
        sorted(audio_root.rglob("*.wav"), key=lambda path: path.as_posix())
        if audio_root.is_dir()
        else []
    )
    for path in candidates:
        relative = path.relative_to(audio_root)
        identity = _match_audio_path(relative, passes, utterance_ids)
        if identity is None:
            extra.append(relative)
            continue
        previous = files.get(identity)
        if previous is not None:
            raise AudioInventoryError(
                "multiple WAV files map to "
                f"pass={identity[0]} utterance={identity[1]}: {previous} and {path}"
            )
        files[identity] = path

    missing = tuple(key for key in expected if key.identity() not in files)
    return AudioInventory(expected, files, missing, tuple(extra))


def validate_wav(path: Path, sample_rate: int) -> int:
    """Require the exact capture contract before Faster-Whisper can resample it."""
    try:
        with wave.open(str(path), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.getnframes()
            compression = handle.getcomptype()
    except (EOFError, wave.Error) as exc:
        raise AudioInventoryError(f"invalid WAV file {path}: {exc}") from exc

    problems: list[str] = []
    if channels != 1:
        problems.append(f"{channels} channels (expected mono)")
    if width != 2:
        problems.append(f"{width * 8}-bit samples (expected signed PCM16)")
    if rate != sample_rate:
        problems.append(f"{rate} Hz (expected {sample_rate} Hz)")
    if compression != "NONE":
        problems.append(f"compression {compression!r} (expected PCM)")
    if frames <= 0:
        problems.append("no audio frames")
    if problems:
        raise AudioInventoryError(f"WAV contract violation in {path}: {', '.join(problems)}")
    return round(frames / rate * 1_000)


def default_audio_decoder(path: Path, sample_rate: int) -> FloatAudio:
    from faster_whisper.audio import decode_audio

    return cast(FloatAudio, decode_audio(str(path), sampling_rate=sample_rate))


def default_model_factory(config: RuntimeConfig) -> WhisperModelLike:
    from faster_whisper import WhisperModel

    config.model_dir.mkdir(parents=True, exist_ok=True)
    model = WhisperModel(
        config.model,
        device=config.device,
        compute_type=config.compute_type,
        download_root=str(config.model_dir),
        local_files_only=False,
    )
    return cast(WhisperModelLike, model)


def _finite_segment_value(segment: SegmentLike, name: str) -> float | None:
    value = getattr(segment, name, None)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    numeric = float(value)
    return numeric if math.isfinite(numeric) else None


def _weighted_segment_metric(segments: Sequence[SegmentLike], name: str) -> float | None:
    weighted_total = 0.0
    total_weight = 0.0
    for segment in segments:
        value = _finite_segment_value(segment, name)
        if value is None:
            continue
        duration = max(float(segment.end) - float(segment.start), 0.001)
        weighted_total += value * duration
        total_weight += duration
    if total_weight == 0:
        return None
    return round(weighted_total / total_weight, 6)


def decode_recording(
    model: WhisperModelLike,
    audio: FloatAudio,
    key: AudioKey,
    config: RuntimeConfig,
    audio_ms: int,
) -> dict[str, object]:
    prompt = dental_prompt()
    options: dict[str, object] = {
        "language": config.language,
        "beam_size": config.beam_size,
        "condition_on_previous_text": False,
        "word_timestamps": False,
        "vad_filter": False,
        "without_timestamps": True,
    }
    if config.bias_mode == "prompt":
        options["initial_prompt"] = prompt
    elif config.bias_mode == "hotwords":
        options["hotwords"] = prompt

    started = time.perf_counter()
    segment_iterator, _ = model.transcribe(audio, **options)
    segments = list(segment_iterator)
    decode_ms = max(0, round((time.perf_counter() - started) * 1_000))
    transcript = " ".join(segment.text.strip() for segment in segments).strip()
    return {
        "pass": key.pass_id,
        "scenarioId": key.scenario_id,
        "cohort": key.cohort,
        "utteranceId": key.utterance_id,
        "chartable": key.chartable,
        "reference": key.reference,
        "transcript": transcript,
        "wer": round(word_error_rate(key.reference, transcript), 6),
        "noSpeechProbability": _weighted_segment_metric(segments, "no_speech_prob"),
        "averageLogProbability": _weighted_segment_metric(segments, "avg_logprob"),
        "audioMs": audio_ms,
        "decodeMs": decode_ms,
    }


def _wer_summary(results: Sequence[dict[str, object]]) -> dict[str, object]:
    errors = 0
    reference_words = 0
    per_result: list[float] = []
    for result in results:
        reference = cast(str, result["reference"])
        transcript = cast(str, result["transcript"])
        counts = align(normalize(reference), normalize(transcript))
        errors += counts.errors
        reference_words += counts.reference_words
        per_result.append(float(cast(float, result["wer"])))
    aggregate = None if reference_words == 0 else round(errors / reference_words, 6)
    mean = None if not per_result else round(sum(per_result) / len(per_result), 6)
    return {
        "aggregateWer": aggregate,
        "meanWer": mean,
        "wordErrors": errors,
        "referenceWords": reference_words,
    }


def summarize_results(
    manifest: DentalManifest,
    inventory: AudioInventory,
    results: Sequence[dict[str, object]],
) -> dict[str, object]:
    summary: dict[str, object] = {
        "complete": inventory.complete,
        "expectedResults": len(inventory.expected),
        "decodedResults": len(results),
        "missingResults": len(inventory.missing),
        "extraAudioFiles": len(inventory.extra),
        **_wer_summary(results),
    }
    by_pass: dict[str, object] = {}
    for pass_id in manifest.passes:
        pass_results = [result for result in results if result["pass"] == pass_id]
        by_pass[pass_id] = {
            "expectedResults": manifest.utterance_count,
            "decodedResults": len(pass_results),
            "missingResults": sum(1 for item in inventory.missing if item.pass_id == pass_id),
            **_wer_summary(pass_results),
        }
    summary["byPass"] = by_pass
    return summary


def missing_audio_report(
    manifest: DentalManifest,
    manifest_path: Path,
    audio_root: Path,
    inventory: AudioInventory,
    configurations: Sequence[RuntimeConfig],
) -> dict[str, object]:
    return {
        "schemaVersion": TRANSCRIPT_SCHEMA_VERSION,
        "kind": "perio-dental-evaluation-plan",
        "status": "ready" if inventory.complete else "blocked-missing-audio",
        "fixture": manifest.fixture_json(manifest_path, audio_root),
        "expectedRecordings": len(inventory.expected),
        "discoveredRecordings": len(inventory.files),
        "missingAudio": [item.missing_json() for item in inventory.missing],
        "extraAudio": [path.as_posix() for path in inventory.extra],
        "runs": [configuration.as_json() for configuration in configurations],
    }


class MissingAudioError(DentalEvaluationError):
    def __init__(self, report: dict[str, object]) -> None:
        missing = cast(list[object], report["missingAudio"])
        expected = cast(int, report["expectedRecordings"])
        super().__init__(
            f"missing {len(missing)} of {expected} expected dental recordings; "
            "run with --plan for the complete capture inventory"
        )
        self.report = report


def evaluate_configuration(
    manifest: DentalManifest,
    manifest_path: Path,
    audio_root: Path,
    inventory: AudioInventory,
    config: RuntimeConfig,
    *,
    allow_missing: bool = False,
    model_factory: ModelFactory = default_model_factory,
    audio_decoder: AudioDecoder = default_audio_decoder,
) -> dict[str, object]:
    """Decode one runtime configuration in manifest order."""
    if inventory.missing and not allow_missing:
        raise MissingAudioError(
            missing_audio_report(manifest, manifest_path, audio_root, inventory, (config,))
        )

    durations: dict[tuple[str, str], int] = {}
    for identity, path in inventory.files.items():
        durations[identity] = validate_wav(path, manifest.sample_rate)

    model = model_factory(config) if inventory.files else None
    results: list[dict[str, object]] = []
    for key in inventory.expected:
        recording_path = inventory.files.get(key.identity())
        if recording_path is None:
            continue
        if model is None:  # pragma: no cover - guarded by the files lookup
            raise AssertionError("model was not loaded for a discovered recording")
        audio = audio_decoder(recording_path, manifest.sample_rate)
        results.append(decode_recording(model, audio, key, config, durations[key.identity()]))

    runtime = config.as_json()
    return {
        "schemaVersion": TRANSCRIPT_SCHEMA_VERSION,
        "kind": "perio-dental-transcripts",
        "fixture": manifest.fixture_json(manifest_path, audio_root),
        "model": runtime["model"],
        "device": runtime["device"],
        "computeType": runtime["computeType"],
        "beamSize": runtime["beamSize"],
        "language": runtime["language"],
        "bias": runtime["bias"],
        "scenarios": [scenario.as_json() for scenario in manifest.scenarios],
        "results": results,
        "missingAudio": [item.missing_json() for item in inventory.missing],
        "extraAudio": [path.as_posix() for path in inventory.extra],
        "summary": summarize_results(manifest, inventory, results),
    }


def build_sweep_plan(base: RuntimeConfig) -> tuple[RuntimeConfig, ...]:
    """The full dental tuning matrix, in stable execution order."""
    return tuple(
        RuntimeConfig(
            model,
            base.device,
            base.compute_type,
            beam_size,
            cast(BiasMode, bias_mode),
            base.language,
            base.model_dir,
        )
        for model in SWEEP_MODELS
        for beam_size in SWEEP_BEAMS
        for bias_mode in SWEEP_BIASES
    )


def runtime_from_settings(
    settings: Settings,
    *,
    model: str | None = None,
    device: str | None = None,
    compute_type: str | None = None,
    beam_size: int | None = None,
    bias_mode: BiasMode | None = None,
) -> RuntimeConfig:
    configured_beam = getattr(settings, "beam_size", None)
    if not isinstance(configured_beam, int):
        try:
            configured_beam = int(os.getenv("ASR_BEAM_SIZE", "1"))
        except ValueError as exc:
            raise DentalEvaluationError("ASR_BEAM_SIZE must be an integer") from exc
    configured_bias: BiasMode = "prompt" if settings.bias_prompt else "off"
    raw_bias = os.getenv("ASR_BIAS_MODE")
    if raw_bias is not None:
        if raw_bias not in SWEEP_BIASES:
            raise DentalEvaluationError("ASR_BIAS_MODE must be off, prompt, or hotwords")
        configured_bias = cast(BiasMode, raw_bias)
    return RuntimeConfig(
        model or settings.model_name,
        device or settings.device,
        compute_type or settings.compute_type,
        beam_size if beam_size is not None else configured_beam,
        bias_mode or configured_bias,
        settings.language,
        settings.model_dir,
    )


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def _print_report(payload: dict[str, object]) -> None:
    fixture = cast(dict[str, object], payload["fixture"])
    summary = cast(dict[str, object], payload["summary"])
    bias = cast(dict[str, object], payload["bias"])
    print(
        f"fixture {fixture['fixtureVersion']} · {summary['decodedResults']}/"
        f"{summary['expectedResults']} recordings"
    )
    print(
        f"model {payload['model']} · device {payload['device']} · compute "
        f"{payload['computeType']} · beam {payload['beamSize']} · bias {bias['mode']}"
    )
    by_pass = cast(dict[str, dict[str, object]], summary["byPass"])
    for pass_id, values in by_pass.items():
        aggregate = values["aggregateWer"]
        rendered = "n/a" if aggregate is None else f"{float(cast(float, aggregate)):.4f}"
        print(
            f"{pass_id:>8}  {values['decodedResults']}/{values['expectedResults']} decoded  "
            f"aggregate WER {rendered}"
        )
    aggregate = summary["aggregateWer"]
    rendered = "n/a" if aggregate is None else f"{float(cast(float, aggregate)):.4f}"
    print(f"aggregate WER {rendered}")
    if int(cast(int, summary["extraAudioFiles"])):
        print(f"NOTE: {summary['extraAudioFiles']} unrecognized WAV file(s) were not decoded")
    print(
        "DENTAL_EVALUATION_COMPLETE"
        if summary["complete"] is True
        else "DENTAL_EVALUATION_INCOMPLETE"
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument(
        "--audio-root",
        type=Path,
        help="directory searched recursively for WAVs (defaults to the manifest directory)",
    )
    parser.add_argument("--json", type=Path, help="write the complete JSON result here")
    parser.add_argument("--model", help="override ASR_MODEL for a single run")
    parser.add_argument("--device", help="override ASR_DEVICE")
    parser.add_argument("--compute-type", help="override ASR_COMPUTE_TYPE")
    parser.add_argument("--beam-size", type=int, help="override ASR_BEAM_SIZE")
    parser.add_argument("--bias", choices=SWEEP_BIASES, help="override decoder bias mode")
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="decode only present recordings and mark the report incomplete",
    )
    parser.add_argument(
        "--plan",
        action="store_true",
        help="print the inventory and runtime plan without loading a model",
    )
    parser.add_argument(
        "--sweep-models",
        action="store_true",
        help="run the tiny/base/small x beam 1/5 x off/prompt/hotwords matrix",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    manifest_path = cast(Path, arguments.manifest)
    audio_root = cast(Path | None, arguments.audio_root) or manifest_path.parent / "audio"

    try:
        manifest = load_manifest(manifest_path)
        inventory = discover_audio(manifest, audio_root)
        settings = Settings.from_env()
        bias = cast(BiasMode | None, arguments.bias)
        base = runtime_from_settings(
            settings,
            model=cast(str | None, arguments.model),
            device=cast(str | None, arguments.device),
            compute_type=cast(str | None, arguments.compute_type),
            beam_size=cast(int | None, arguments.beam_size),
            bias_mode=bias,
        )
        configurations = build_sweep_plan(base) if arguments.sweep_models else (base,)
        plan = missing_audio_report(manifest, manifest_path, audio_root, inventory, configurations)
        output_path = cast(Path | None, arguments.json)
        if arguments.plan:
            if output_path is not None:
                _write_json(output_path, plan)
            print(json.dumps(plan, indent=2, allow_nan=False))
            return 0
        if inventory.missing and not arguments.allow_missing:
            raise MissingAudioError(plan)

        if arguments.sweep_models:
            runs = [
                evaluate_configuration(
                    manifest,
                    manifest_path,
                    audio_root,
                    inventory,
                    configuration,
                    allow_missing=arguments.allow_missing,
                )
                for configuration in configurations
            ]
            payload: dict[str, object] = {
                "schemaVersion": TRANSCRIPT_SCHEMA_VERSION,
                "kind": "perio-dental-sweep",
                "fixture": manifest.fixture_json(manifest_path, audio_root),
                "scenarios": [scenario.as_json() for scenario in manifest.scenarios],
                "plan": [configuration.as_json() for configuration in configurations],
                "runs": runs,
            }
            if output_path is not None:
                _write_json(output_path, payload)
            print(
                f"completed {len(runs)} dental decoder runs across "
                f"{len(inventory.files)} recordings"
            )
            print("DENTAL_SWEEP_COMPLETE")
            return 0

        payload = evaluate_configuration(
            manifest,
            manifest_path,
            audio_root,
            inventory,
            base,
            allow_missing=arguments.allow_missing,
        )
        if output_path is not None:
            _write_json(output_path, payload)
        _print_report(payload)
        return 0
    except MissingAudioError as exc:
        output_path = cast(Path | None, arguments.json)
        if output_path is not None:
            _write_json(output_path, exc.report)
        print(f"DENTAL_AUDIO_INCOMPLETE: {exc}", file=sys.stderr)
        print(json.dumps(exc.report, indent=2, allow_nan=False), file=sys.stderr)
        return 2
    except (DentalEvaluationError, OSError) as exc:
        print(f"DENTAL_EVALUATION_ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
