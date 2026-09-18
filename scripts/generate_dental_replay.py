"""Render the dental fixture prompts with the repository's pinned Piper voice.

Piper is a generation-only dependency. The resulting small WAV stimuli are
checked in so acoustic replay stays offline and does not need a TTS runtime:

    uv run --with piper-tts python scripts/generate_dental_replay.py
"""

from __future__ import annotations

import hashlib
import json
import wave
from pathlib import Path
from typing import cast

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "evaluation" / "fixtures" / "dental" / "phrases.json"
OUTPUT_DIR = MANIFEST_PATH.parent / "tts"
VOICE_DIR = ROOT / "evaluation" / "fixtures" / "synthetic-dental" / "voices"
VOICE_NAME = "en_US-lessac-medium"


def fixture_prompts() -> dict[str, str]:
    raw = cast(dict[str, object], json.loads(MANIFEST_PATH.read_text(encoding="utf-8")))
    scenarios = cast(list[dict[str, object]], raw["scenarios"])
    prompts: dict[str, str] = {}
    for scenario in scenarios:
        for utterance in cast(list[dict[str, object]], scenario["utterances"]):
            utterance_id = cast(str, utterance["id"])
            prompt = cast(str, utterance["prompt"])
            if utterance_id in prompts:
                raise ValueError(f"duplicate utterance id: {utterance_id}")
            prompts[utterance_id] = prompt
    return prompts


def main() -> int:
    from piper import PiperVoice

    model_path = VOICE_DIR / f"{VOICE_NAME}.onnx"
    config_path = VOICE_DIR / f"{VOICE_NAME}.onnx.json"
    if not model_path.is_file() or not config_path.is_file():
        raise FileNotFoundError(f"pinned Piper voice is missing from {VOICE_DIR}")

    prompts = fixture_prompts()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    voice = PiperVoice.load(model_path, config_path=config_path)
    records: dict[str, dict[str, str]] = {}
    for utterance_id, prompt in prompts.items():
        output_path = OUTPUT_DIR / f"{utterance_id}.wav"
        with wave.open(str(output_path), "wb") as target:
            voice.synthesize_wav(prompt, target)
        records[utterance_id] = {
            "promptSha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            "wavSha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
        }

    metadata = {
        "schemaVersion": 1,
        "voice": VOICE_NAME,
        "manifest": MANIFEST_PATH.relative_to(ROOT).as_posix(),
        "records": records,
    }
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    print(f"generated {len(prompts)} local-TTS stimuli with {VOICE_NAME}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
