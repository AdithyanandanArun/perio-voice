from __future__ import annotations

import asyncio

from server.audio import FloatAudio
from server.recognizer import ModelStatus, RecognitionResult, WordTiming


class FakeRecognizer:
    model_name = "fake-clinical-en"
    device = "test"
    compute_type = "float32"

    def __init__(self, *, delay: float = 0) -> None:
        self.status = ModelStatus.IDLE
        self.error: str | None = None
        self.delay = delay
        self.calls: list[tuple[int, bool]] = []

    async def load(self) -> None:
        self.status = ModelStatus.READY

    async def transcribe(self, audio: FloatAudio, *, partial: bool) -> RecognitionResult:
        if self.delay:
            await asyncio.sleep(self.delay)
        self.calls.append((len(audio), partial))
        return RecognitionResult(
            text="three four" if partial else "three four five",
            decode_ms=4,
            words=() if partial else (WordTiming("three", 0, 180, 0.99),),
        )


class SlowLoadingRecognizer(FakeRecognizer):
    async def load(self) -> None:
        self.status = ModelStatus.LOADING
        await asyncio.sleep(0.05)
        self.status = ModelStatus.READY


class FailOnceRecognizer(FakeRecognizer):
    def __init__(self) -> None:
        super().__init__()
        self.load_attempts = 0

    async def load(self) -> None:
        self.load_attempts += 1
        if self.load_attempts == 1:
            self.status = ModelStatus.ERROR
            self.error = "download interrupted"
            raise RuntimeError(self.error)
        self.error = None
        self.status = ModelStatus.READY
