"""Downloads the Whisper model the service will load on this machine.

Resolved through `service_settings()`, so a GPU machine fetches large-v3 and a
CPU machine tiny.en. Idempotent: an artifact already in `models/` is reused.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.config import service_settings


def main() -> int:
    from faster_whisper.utils import download_model

    settings = service_settings()
    settings.model_dir.mkdir(parents=True, exist_ok=True)
    print(f"fetching {settings.model_name} for {settings.device} into {settings.model_dir}")
    path = download_model(settings.model_name, cache_dir=str(settings.model_dir))
    print(f"{settings.model_name} ready at {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
