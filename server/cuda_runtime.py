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
import re
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True, slots=True)
class CudaCapabilities:
    """Identifier-free CUDA facts used to select and report a safe profile.

    CTranslate2 exposes whether a CUDA device exists, but not its memory size
    or compute capability.  ``nvidia-smi`` is queried when it is available so
    the service can retain the deployment facts without adding a GPU Python
    dependency.  Unknown facts are deliberately represented as ``None``; a
    missing query must not make a known-good CUDA runtime look unavailable.
    """

    available: bool
    device_count: int
    device_name: str | None
    memory_mib: int | None
    compute_capability: str | None
    runtime_libraries: tuple[str, ...]
    error: str | None = None

    @property
    def vram_mib(self) -> int | None:
        """Alias used by profile consumers that call the memory VRAM."""
        return self.memory_mib

    @property
    def memory_bytes(self) -> int | None:
        return None if self.memory_mib is None else self.memory_mib * 1_048_576

    @property
    def vram_bytes(self) -> int | None:
        return self.memory_bytes

    @property
    def profile_name(self) -> str:
        """The conservative profile family supported by this runtime."""
        if not self.available:
            return "cpu-reference"
        if self.memory_mib is None:
            return "cuda-unknown-vram"
        if self.memory_mib is not None and self.memory_mib < 4_096:
            return "cuda-insufficient-vram"
        return "cuda-4gb"

    def as_dict(self) -> dict[str, object]:
        """Serialize non-sensitive capability metadata for health/debug output."""
        return {
            "available": self.available,
            "deviceCount": self.device_count,
            "deviceName": self.device_name,
            "memoryMiB": self.memory_mib,
            "computeCapability": self.compute_capability,
            "runtimeLibraries": list(self.runtime_libraries),
            "profile": self.profile_name,
            "error": self.error,
        }


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


def _query_device_metadata() -> tuple[str | None, int | None, str | None, str | None]:
    """Read the first GPU's static facts without making them required.

    The target workstation is an RTX 3050 Laptop GPU (4096 MiB, compute 8.6).
    A packaged service may run where ``nvidia-smi`` is absent, so command
    failures are returned as metadata rather than raised from startup.
    """
    executable = shutil.which("nvidia-smi")
    if executable is None:
        return None, None, None, "nvidia-smi is unavailable"
    try:
        completed = subprocess.run(
            [
                executable,
                "--query-gpu=name,memory.total,compute_cap",
                "--format=csv,noheader,nounits",
                "-i",
                "0",
            ],
            capture_output=True,
            check=False,
            text=True,
            timeout=1.0,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return None, None, None, f"nvidia-smi query failed: {type(error).__name__}"
    if completed.returncode != 0:
        return None, None, None, "nvidia-smi query returned a non-zero status"
    line = next((line.strip() for line in completed.stdout.splitlines() if line.strip()), "")
    fields = [field.strip() for field in line.split(",")]
    if len(fields) < 3:
        return None, None, None, "nvidia-smi returned incomplete GPU metadata"
    name = fields[0] or None
    memory_match = re.search(r"\d+", fields[1])
    memory_mib = int(memory_match.group()) if memory_match else None
    compute = fields[2] or None
    return name, memory_mib, compute, None


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
def cuda_capabilities() -> CudaCapabilities:
    """Return the usable CUDA runtime and its non-sensitive capability facts.

    A device alone is not enough: CTranslate2 reports the RTX 4060 whether or not
    cuBLAS and cuDNN are present, and without them the first decode fails. That
    is a worse outcome than running on the CPU, so both are required.
    """
    device_count = 0
    failure: str | None = None
    try:
        import ctranslate2

        device_count = ctranslate2.get_cuda_device_count()
    except Exception as error:
        failure = f"CUDA device query failed: {type(error).__name__}"
    loaded = ensure_cuda_libraries()
    libraries_ready = any(name.startswith("libcublas.so") for name in loaded) and any(
        name.startswith("libcudnn") for name in loaded
    )
    device_name, memory_mib, compute_capability, query_error = _query_device_metadata()
    if failure is None:
        failure = query_error
    available = device_count > 0 and libraries_ready
    if not available and failure is None:
        failure = "CUDA device or runtime libraries are unavailable"
    return CudaCapabilities(
        available=available,
        device_count=device_count,
        device_name=device_name,
        memory_mib=memory_mib,
        compute_capability=compute_capability,
        runtime_libraries=loaded,
        error=failure,
    )


@lru_cache(maxsize=1)
def cuda_available() -> bool:
    """True only when a CUDA device exists *and* its runtime libraries loaded."""
    return cuda_capabilities().available
