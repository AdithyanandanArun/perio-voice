"""Downloads the grammar recognizer model.

Kept out of the package install because it is a 128 MB artifact and the rest of
the setup should stay fast. `npm run setup` calls this; it is idempotent and
verifies the archive before extracting.
"""

from __future__ import annotations

import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

MODEL_NAME = "vosk-model-en-us-0.22-lgraph"
MODEL_URL = f"https://alphacephei.com/vosk/models/{MODEL_NAME}.zip"
MODELS_DIR = Path("models")


def _report(done: int, block: int, total: int) -> None:
    if total <= 0:
        return
    percent = min(100, done * block * 100 // total)
    sys.stdout.write(f"\r  {percent:3d}%  {MODEL_NAME}")
    sys.stdout.flush()


def main() -> int:
    destination = MODELS_DIR / MODEL_NAME
    if (destination / "am").is_dir() or (destination / "conf").is_dir():
        print(f"{MODEL_NAME} already present at {destination}")
        return 0

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    archive = MODELS_DIR / f"{MODEL_NAME}.zip"
    print(f"fetching {MODEL_URL}")
    try:
        urllib.request.urlretrieve(MODEL_URL, archive, _report)
        print()
        with zipfile.ZipFile(archive) as bundle:
            # Refuse absolute or traversing members rather than trusting the archive.
            for member in bundle.namelist():
                target = (MODELS_DIR / member).resolve()
                if not str(target).startswith(str(MODELS_DIR.resolve())):
                    raise RuntimeError(f"Refusing unsafe archive member: {member}")
            bundle.extractall(MODELS_DIR)
    finally:
        archive.unlink(missing_ok=True)

    if not (destination / "conf").is_dir():
        shutil.rmtree(destination, ignore_errors=True)
        raise RuntimeError(f"{MODEL_NAME} did not extract into the expected layout.")
    print(f"installed {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
