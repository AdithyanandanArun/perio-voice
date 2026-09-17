"""Renders one utterance per clinical word.

`scripts/verify_no_forced_substitution.py` and `verify_confusable_pairs.py` need
to hear every word the product claims to understand. A static check that a word
is present in a grammar is not enough: the failure that motivated this was a word
being recognized as a *different* clinical word, which only audio can show.

Piper is not a project dependency; the rendered audio is committed so the gates
run without a TTS stack.

    uv run --with piper-tts python scripts/generate_vocabulary_audio.py
"""

from __future__ import annotations

import json
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.vocabulary import every_word

FIXTURE = Path("evaluation/fixtures/synthetic-dental")
VOICE = "en_US-lessac-medium"

"""Function words are excluded: they never become a chart entry on their own and
rendering them in isolation is not meaningful."""
SKIP = frozenset({"of", "or", "and", "to", "that", "this", "it", "on", "up", "go", "over"})


def main() -> int:
    from piper import PiperVoice
    from piper.download_voices import download_voice

    voices = FIXTURE / "voices"
    voices.mkdir(parents=True, exist_ok=True)
    download_voice(VOICE, voices)
    voice = PiperVoice.load(voices / f"{VOICE}.onnx")

    # Clear first: a word removed from the vocabulary must not leave audio
    # behind, or the gates keep testing a word the product no longer knows.
    out = FIXTURE / "vocabulary"
    if out.is_dir():
        for stale in out.glob("*.wav"):
            stale.unlink()
    out.mkdir(parents=True, exist_ok=True)
    rendered: dict[str, str] = {}
    for word in sorted(every_word()):
        if word in SKIP:
            continue
        name = word.replace("-", "_")
        with wave.open(str(out / f"{name}.wav"), "wb") as handle:
            voice.synthesize_wav(word, handle)
        rendered[name] = word

    (FIXTURE / "vocabulary.json").write_text(
        json.dumps(rendered, indent=1, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"rendered {len(rendered)} clinical words into {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
