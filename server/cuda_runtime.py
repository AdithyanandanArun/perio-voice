"""Make the pip-installed CUDA libraries loadable before inference starts.

CTranslate2 4.x detects a CUDA device on its own but loads cuBLAS and cuDNN 9 by
soname at the moment of the first decode, and it does not ship them. The `gpu`
extra installs them as Python packages, which puts them somewhere the dynamic
loader does not look. Without this, the service reports a ready CUDA model and
then fails the first utterance with "libcublas.so.12 is not found".

Setting LD_LIBRARY_PATH would also work, but it has to be set before the process
starts and is one more thing to forget. Loading the libraries here with
RTLD_GLOBAL means a later dlopen by soname finds the copy already in memory.
"""

from __future__ import annotations

import ctypes
import glob
import os
from functools import lru_cache
from pathlib import Path

"""Load order matters: cuBLAS depends on cuBLASLt, and cuDNN's sublibraries
depend on each other. Anything that fails is retried once its dependencies have
loaded, so the order below is a hint rather than a requirement."""
_PATTERNS = (
    "cublas/lib/libcublasLt.so.*",
    "cublas/lib/libcublas.so.*",
    "cuda_nvrtc/lib/libnvrtc*.so.*",
    "cudnn/lib/libcudnn*.so.*",
)


def _nvidia_root() -> Path | None:
    try:
        import nvidia  # type: ignore[import-not-found]
    except ImportError:
        return None
    locations = list(getattr(nvidia, "__path__", []))
    return Path(locations[0]) if locations else None


@lru_cache(maxsize=1)
def ensure_cuda_libraries() -> tuple[str, ...]:
    """Preloads every CUDA runtime library the gpu extra installed.

    Returns the libraries that loaded. An empty result means the extra is not
    installed, which is correct on a CPU-only machine and not an error.
    """
    root = _nvidia_root()
    if root is None:
        return ()
    pending = [
        path
        for pattern in _PATTERNS
        for path in sorted(glob.glob(str(root / pattern)))
        if not path.endswith(".alt")
    ]
    loaded: list[str] = []
    while pending:
        still_pending: list[str] = []
        for path in pending:
            try:
                ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
                loaded.append(os.path.basename(path))
            except OSError:
                still_pending.append(path)
        if len(still_pending) == len(pending):
            break
        pending = still_pending
    return tuple(loaded)


@lru_cache(maxsize=1)
def cuda_available() -> bool:
    """True only when a CUDA device exists *and* its runtime libraries loaded.

    A device alone is not enough: CTranslate2 reports the RTX 4060 whether or not
    cuBLAS and cuDNN are present, and without them the first decode fails. That
    is a worse outcome than running on the CPU, so both are required.
    """
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() < 1:
            return False
    except Exception:
        return False
    loaded = ensure_cuda_libraries()
    return any(name.startswith("libcublas.so") for name in loaded) and any(
        name.startswith("libcudnn") for name in loaded
    )
