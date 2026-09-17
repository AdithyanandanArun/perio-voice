"""Dental fixture evaluation is useful only when inventory and metadata are exact."""

from __future__ import annotations

import json
import wave
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest

from scripts.evaluate_dental import (
    AudioInventoryError,
    ManifestError,
    MissingAudioError,
    RuntimeConfig,
    build_sweep_plan,
    discover_audio,
    evaluate_configuration,
    load_manifest,
    missing_audio_report,
)


def manifest_payload() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "fixtureVersion": "test-fixture-1",
        "sampleRate": 16_000,
        "passes": ["quiet", "noise"],
        "scenarios": [
            {
                "id": "basic-depths",
                "cohort": "clean",
                "settings": {"autoAdvance": False},
                "start": {"tooth": 14, "surface": "buccal"},
                "utterances": [
                    {
                        "id": "depths-345",
                        "prompt": "three four five",
                        "chartable": True,
                    }
                ],
                "expect": {
                    "records": [
                        {
                            "tooth": 14,
                            "surface": "buccal",
                            "probingDepths": [3, 4, 5],
                        }
                    ]
                },
            }
        ],
    }


def write_manifest(directory: Path, payload: dict[str, object] | None = None) -> Path:
    path = directory / "phrases.json"
    path.write_text(json.dumps(payload or manifest_payload()), encoding="utf-8")
    return path


def write_wav(path: Path, *, sample_rate: int = 16_000, channels: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    samples = np.zeros(sample_rate // 20 * channels, dtype="<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(samples.tobytes())


def runtime() -> RuntimeConfig:
    return RuntimeConfig(
        model="base.en",
        device="cpu",
        compute_type="int8",
        beam_size=5,
        bias_mode="prompt",
        language="en",
        model_dir=Path("models"),
    )


@dataclass(frozen=True)
class FakeSegment:
    text: str
    start: float
    end: float
    no_speech_prob: float
    avg_logprob: float


class FakeModel:
    def __init__(self) -> None:
        self.options: list[dict[str, object]] = []

    def transcribe(
        self, audio: np.ndarray, **options: object
    ) -> tuple[Iterable[FakeSegment], object]:
        self.options.append(options)
        if float(audio[0]) == 0.0:
            return (
                [
                    FakeSegment(" three four ", 0.0, 1.0, 0.1, -0.2),
                    FakeSegment(" five ", 1.0, 4.0, 0.3, -0.6),
                ],
                object(),
            )
        return ([FakeSegment(" three for five ", 0.0, 2.0, 0.4, -0.7)], object())


def fake_decoder(path: Path, sample_rate: int) -> np.ndarray:
    assert sample_rate == 16_000
    marker = 0.0 if "quiet" in path.parts else 1.0
    return np.array([marker], dtype=np.float32)


def test_complete_fixture_decodes_in_manifest_order_with_runtime_metadata(tmp_path: Path) -> None:
    manifest_path = write_manifest(tmp_path)
    write_wav(tmp_path / "quiet" / "depths-345.wav")
    write_wav(tmp_path / "noise" / "depths-345.wav")
    manifest = load_manifest(manifest_path)
    inventory = discover_audio(manifest, tmp_path)
    model = FakeModel()

    report = evaluate_configuration(
        manifest,
        manifest_path,
        tmp_path,
        inventory,
        runtime(),
        model_factory=lambda _configuration: model,
        audio_decoder=fake_decoder,
    )

    assert report["kind"] == "perio-dental-transcripts"
    assert report["model"] == "base.en"
    assert report["device"] == "cpu"
    assert report["computeType"] == "int8"
    assert report["beamSize"] == 5
    assert report["bias"]["mode"] == "prompt"  # type: ignore[index]
    assert [row["pass"] for row in report["results"]] == ["quiet", "noise"]  # type: ignore[index]

    quiet, noisy = report["results"]  # type: ignore[misc]
    assert quiet["reference"] == "three four five"
    assert quiet["transcript"] == "three four five"
    assert quiet["wer"] == 0
    assert quiet["noSpeechProbability"] == pytest.approx(0.25)
    assert quiet["averageLogProbability"] == pytest.approx(-0.5)
    assert isinstance(quiet["decodeMs"], int)
    assert noisy["transcript"] == "three for five"
    assert noisy["wer"] == pytest.approx(1 / 3, abs=1e-6)

    summary = report["summary"]
    assert summary["complete"] is True  # type: ignore[index]
    assert summary["expectedResults"] == 2  # type: ignore[index]
    assert summary["decodedResults"] == 2  # type: ignore[index]
    assert summary["aggregateWer"] == pytest.approx(1 / 6, abs=1e-6)  # type: ignore[index]
    assert all(options["beam_size"] == 5 for options in model.options)
    assert all("initial_prompt" in options for options in model.options)
    assert all("temperature" not in options for options in model.options)


def test_missing_audio_is_structured_and_prevents_model_loading(tmp_path: Path) -> None:
    manifest_path = write_manifest(tmp_path)
    write_wav(tmp_path / "quiet" / "depths-345.wav")
    manifest = load_manifest(manifest_path)
    inventory = discover_audio(manifest, tmp_path)
    loaded = False

    def forbidden_model_factory(_configuration: RuntimeConfig) -> FakeModel:
        nonlocal loaded
        loaded = True
        return FakeModel()

    with pytest.raises(MissingAudioError) as caught:
        evaluate_configuration(
            manifest,
            manifest_path,
            tmp_path,
            inventory,
            runtime(),
            model_factory=forbidden_model_factory,
            audio_decoder=fake_decoder,
        )

    assert loaded is False
    assert caught.value.report["status"] == "blocked-missing-audio"
    assert caught.value.report["expectedRecordings"] == 2
    assert caught.value.report["discoveredRecordings"] == 1
    assert caught.value.report["missingAudio"] == [
        {
            "pass": "noise",
            "scenarioId": "basic-depths",
            "utteranceId": "depths-345",
            "expectedPath": "noise/depths-345.wav",
        }
    ]


def test_allow_missing_never_marks_partial_output_complete(tmp_path: Path) -> None:
    manifest_path = write_manifest(tmp_path)
    write_wav(tmp_path / "quiet" / "depths-345.wav")
    manifest = load_manifest(manifest_path)
    inventory = discover_audio(manifest, tmp_path)

    report = evaluate_configuration(
        manifest,
        manifest_path,
        tmp_path,
        inventory,
        runtime(),
        allow_missing=True,
        model_factory=lambda _configuration: FakeModel(),
        audio_decoder=fake_decoder,
    )

    assert report["summary"]["complete"] is False  # type: ignore[index]
    assert report["summary"]["missingResults"] == 1  # type: ignore[index]
    assert len(report["missingAudio"]) == 1  # type: ignore[arg-type]


def test_inventory_reports_unknown_wavs_and_rejects_duplicate_mappings(tmp_path: Path) -> None:
    manifest = load_manifest(write_manifest(tmp_path))
    write_wav(tmp_path / "quiet" / "depths-345.wav")
    write_wav(tmp_path / "noise" / "depths-345.wav")
    write_wav(tmp_path / "unregistered.wav")

    inventory = discover_audio(manifest, tmp_path)
    assert inventory.extra == (Path("unregistered.wav"),)

    write_wav(tmp_path / "depths-345.quiet.wav")
    with pytest.raises(AudioInventoryError, match="multiple WAV files map"):
        discover_audio(manifest, tmp_path)


def test_wrong_rate_is_rejected_before_model_loading(tmp_path: Path) -> None:
    manifest_path = write_manifest(tmp_path)
    write_wav(tmp_path / "quiet" / "depths-345.wav", sample_rate=8_000)
    write_wav(tmp_path / "noise" / "depths-345.wav")
    manifest = load_manifest(manifest_path)
    inventory = discover_audio(manifest, tmp_path)
    loaded = False

    def forbidden_model_factory(_configuration: RuntimeConfig) -> FakeModel:
        nonlocal loaded
        loaded = True
        return FakeModel()

    with pytest.raises(AudioInventoryError, match=r"8000 Hz.*expected 16000 Hz"):
        evaluate_configuration(
            manifest,
            manifest_path,
            tmp_path,
            inventory,
            runtime(),
            model_factory=forbidden_model_factory,
            audio_decoder=fake_decoder,
        )
    assert loaded is False


def test_manifest_rejects_duplicate_global_ids_and_wrong_passes(tmp_path: Path) -> None:
    duplicate = manifest_payload()
    scenarios = duplicate["scenarios"]
    assert isinstance(scenarios, list)
    scenarios.append(
        {
            "id": "second",
            "cohort": "terminology",
            "utterances": [{"id": "depths-345", "prompt": "bleeding"}],
            "expect": {},
        }
    )
    with pytest.raises(ManifestError, match="duplicate global utterance id"):
        load_manifest(write_manifest(tmp_path, duplicate))

    wrong_passes = manifest_payload()
    wrong_passes["passes"] = ["quiet"]
    with pytest.raises(ManifestError, match="exactly 'quiet' and 'noise'"):
        load_manifest(write_manifest(tmp_path, wrong_passes))


def test_sweep_plan_is_complete_unique_and_visible_in_inventory_plan(tmp_path: Path) -> None:
    manifest_path = write_manifest(tmp_path)
    manifest = load_manifest(manifest_path)
    inventory = discover_audio(manifest, tmp_path)
    configurations = build_sweep_plan(runtime())

    assert len(configurations) == 18
    assert len({configuration.id for configuration in configurations}) == 18
    assert {configuration.model for configuration in configurations} == {
        "tiny.en",
        "base.en",
        "small.en",
    }
    assert {configuration.beam_size for configuration in configurations} == {1, 5}
    assert {configuration.bias_mode for configuration in configurations} == {
        "off",
        "prompt",
        "hotwords",
    }

    plan = missing_audio_report(
        manifest,
        manifest_path,
        tmp_path,
        inventory,
        configurations,
    )
    assert plan["status"] == "blocked-missing-audio"
    assert len(plan["runs"]) == 18  # type: ignore[arg-type]
    assert len(plan["missingAudio"]) == 2  # type: ignore[arg-type]
