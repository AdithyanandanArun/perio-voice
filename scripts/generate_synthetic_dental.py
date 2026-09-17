"""Regenerates the synthetic dental fixture.

Piper is intentionally not a project dependency: the rendered audio is committed
so the gates that use it run without a TTS stack. Run this only to change the
phrase set or the voice.

    uv run --with piper-tts --with soundfile python scripts/generate_synthetic_dental.py
"""

from __future__ import annotations

import json
import wave
from pathlib import Path

FIXTURE = Path("evaluation/fixtures/synthetic-dental")
VOICE = "en_US-lessac-medium"

PHRASES: tuple[tuple[str, str], ...] = (
    ("d1", "three four five"),
    ("d2", "two three four"),
    ("d3", "five six seven"),
    ("d4", "one two three"),
    ("d5", "four four five"),
    ("d6", "six five four"),
    ("s1", "three"),
    ("s2", "four"),
    ("s3", "five"),
    ("s4", "two"),
    ("s5", "eight"),
    ("s6", "six"),
    ("f1", "bleeding"),
    ("f2", "no bleeding"),
    ("f3", "suppuration"),
    ("f4", "plaque"),
    ("f5", "calculus"),
    ("f6", "mobility two"),
    ("c1", "tooth fifteen"),
    ("c2", "tooth fourteen lingual"),
    ("c3", "buccal"),
    ("c4", "lower left"),
    ("x1", "four no three"),
    ("x2", "repeat that three four four"),
    ("x3", "tooth fourteen sorry fifteen"),
    ("w1", "next tooth"),
    ("w2", "skip this tooth"),
    ("w3", "undo that"),
    ("n1", "can you pass me that"),
    ("n2", "okay this looks fine"),
)


def main() -> int:
    from piper import PiperVoice
    from piper.download_voices import download_voice

    voices = FIXTURE / "voices"
    voices.mkdir(parents=True, exist_ok=True)
    download_voice(VOICE, voices)
    voice = PiperVoice.load(voices / f"{VOICE}.onnx")

    audio_dir = FIXTURE / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    truth: dict[str, str] = {}
    for utterance_id, text in PHRASES:
        with wave.open(str(audio_dir / f"{utterance_id}.wav"), "wb") as handle:
            voice.synthesize_wav(text, handle)
        truth[utterance_id] = text

    (FIXTURE / "truth.json").write_text(json.dumps(truth, indent=1) + "\n", encoding="utf-8")
    print(f"generated {len(truth)} utterances into {audio_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
