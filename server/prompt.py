"""The recognizer's biasing prompt, shared with the browser lexicon.

Whisper conditions its decoder on this text, which is how rare clinical
vocabulary outranks the common English word the model would otherwise emit
("buccal" over "buckle", "furcation" over "vacation"). The browser lexicon reads
the same file, so both halves of the system bias identically and a vocabulary
change cannot land on one side only.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

PROMPT_FILE = Path(__file__).resolve().parents[1] / "shared" / "dental-prompt.json"


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    with PROMPT_FILE.open(encoding="utf-8") as handle:
        loaded: dict[str, Any] = json.load(handle)
    if not isinstance(loaded.get("prompt"), str) or not loaded["prompt"].strip():
        raise ValueError(f"{PROMPT_FILE} does not define a non-empty prompt.")
    return loaded


def dental_prompt() -> str:
    prompt: str = _load()["prompt"]
    return prompt


def prompt_version() -> str:
    version: str = str(_load().get("version", "unknown"))
    return version
