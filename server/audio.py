from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from enum import StrEnum

import numpy as np
from numpy.typing import NDArray

from server.config import Settings

FloatAudio = NDArray[np.float32]


class DecodeKind(StrEnum):
    PARTIAL = "partial"
    FINAL = "final"


@dataclass(frozen=True, slots=True)
class SpeechStarted:
    utterance_id: int
    started_at_ms: float


@dataclass(frozen=True, slots=True)
class DecodeRequest:
    utterance_id: int
    kind: DecodeKind
    audio: FloatAudio
    started_at_ms: float
    ended_at_ms: float
    sample_rate: int = 16_000
    """Set when the request entered the decode queue, for queue-wait telemetry."""
    queued_at_ms: float = 0.0
    """Server monotonic timestamp of the final voiced frame in this utterance."""
    last_voiced_at_ms: float = 0.0

    @property
    def audio_ms(self) -> int:
        return round(len(self.audio) / self.sample_rate * 1_000)


SegmenterEvent = SpeechStarted | DecodeRequest


def decode_pcm16(payload: bytes) -> FloatAudio:
    """Convert little-endian mono PCM16 bytes to normalized float audio."""
    if not payload or len(payload) % 2:
        raise ValueError("Audio frames must contain an even, non-zero number of PCM16 bytes.")
    pcm = np.frombuffer(payload, dtype="<i2")
    return (pcm.astype(np.float32) / 32_768.0).copy()


def rms_level(audio: FloatAudio) -> float:
    if audio.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(audio, dtype=np.float32))))


class SpeechSegmenter:
    """Energy-based endpointing with pre-roll and periodic partial snapshots."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        # Mutable so the cadence controller can move the endpoint inside its
        # safe band without rebuilding the segmenter mid-stream.
        self.end_silence_ms = settings.end_silence_ms
        # Tracks the quietest recent audio so the speech threshold can sit a
        # fixed margin above the room rather than at a fixed absolute level.
        self._noise_floor = settings.vad_rms_threshold
        self._pre_roll: deque[tuple[FloatAudio, float]] = deque()
        self._pre_roll_samples = 0
        self._speech_chunks: list[FloatAudio] = []
        self._in_speech = False
        self._utterance_id = 0
        self._started_at_ms = 0.0
        self._utterance_samples = 0
        self._voiced_samples = 0
        self._silence_samples = 0
        self._since_partial_samples = 0
        self._last_voiced_at_ms = 0.0

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    def feed(self, payload: bytes, received_at_ms: float) -> list[SegmenterEvent]:
        audio = decode_pcm16(payload)
        duration_ms = len(audio) / self.settings.sample_rate * 1_000
        frame_started_at = received_at_ms - duration_ms
        voiced = self._is_voiced(rms_level(audio))
        events: list[SegmenterEvent] = []

        if not self._in_speech:
            if not voiced:
                self._remember_pre_roll(audio, frame_started_at)
                return events
            self._utterance_id += 1
            self._in_speech = True
            self._started_at_ms = self._pre_roll[0][1] if self._pre_roll else frame_started_at
            self._speech_chunks = [*[chunk for chunk, _ in self._pre_roll], audio]
            self._utterance_samples = sum(len(chunk) for chunk in self._speech_chunks)
            self._voiced_samples = len(audio)
            self._silence_samples = 0
            self._since_partial_samples = 0
            self._last_voiced_at_ms = received_at_ms
            self._pre_roll.clear()
            self._pre_roll_samples = 0
            events.append(SpeechStarted(self._utterance_id, self._started_at_ms))
        else:
            self._speech_chunks.append(audio)
            self._utterance_samples += len(audio)
            self._since_partial_samples += len(audio)
            if voiced:
                self._voiced_samples += len(audio)
                self._last_voiced_at_ms = received_at_ms
            self._silence_samples = 0 if voiced else self._silence_samples + len(audio)

        utterance_ms = self._utterance_samples / self.settings.sample_rate * 1_000
        voiced_ms = self._voiced_samples / self.settings.sample_rate * 1_000
        silence_ms = self._silence_samples / self.settings.sample_rate * 1_000
        since_partial_ms = self._since_partial_samples / self.settings.sample_rate * 1_000
        if utterance_ms >= self.settings.max_utterance_ms:
            events.append(self._finish(received_at_ms))
        elif silence_ms >= self.end_silence_ms:
            if voiced_ms >= self.settings.min_speech_ms:
                events.append(self._finish(received_at_ms))
            else:
                self._reset()
        elif (
            voiced
            and voiced_ms >= self.settings.min_speech_ms
            and since_partial_ms >= self.settings.partial_interval_ms
        ):
            self._since_partial_samples = 0
            events.append(self._snapshot(DecodeKind.PARTIAL, received_at_ms))
        return events

    def _is_voiced(self, level: float) -> bool:
        """Speech is judged against the room, not against a fixed number.

        A single absolute threshold has to be set for one microphone at one
        distance. Measured on real continuous speech, the tenth percentile of
        frame level fell *below* the configured threshold, so the quietest tenth
        of genuine speech was being classified as silence — which clips word
        onsets and ends utterances early. Tracking the noise floor and requiring
        a margin above it adapts to a quiet speaker, a distant microphone and a
        noisy room without any of them needing to be configured.
        """
        threshold = max(
            self.settings.vad_rms_threshold, self._noise_floor * self.settings.vad_margin
        )
        voiced = level >= threshold
        if not voiced:
            # Adapt upward slowly and downward quickly: a room that gets louder
            # should not silence the clinician, but a room that goes quiet should
            # let a quiet voice through promptly.
            weight = 0.05 if level > self._noise_floor else 0.5
            self._noise_floor += weight * (level - self._noise_floor)
            self._noise_floor = max(self._noise_floor, 1e-6)
        return voiced

    @property
    def noise_floor(self) -> float:
        return self._noise_floor

    def flush(self, received_at_ms: float) -> DecodeRequest | None:
        if not self._in_speech or not self._speech_chunks:
            self._reset()
            return None
        voiced_ms = self._voiced_samples / self.settings.sample_rate * 1_000
        request = self._finish(received_at_ms)
        return request if voiced_ms >= self.settings.min_speech_ms else None

    def _remember_pre_roll(self, audio: FloatAudio, started_at_ms: float) -> None:
        self._pre_roll.append((audio, started_at_ms))
        self._pre_roll_samples += len(audio)
        limit = round(self.settings.sample_rate * self.settings.pre_roll_ms / 1_000)
        while self._pre_roll and self._pre_roll_samples > limit:
            removed, _ = self._pre_roll.popleft()
            self._pre_roll_samples -= len(removed)

    def _snapshot(self, kind: DecodeKind, ended_at_ms: float) -> DecodeRequest:
        return DecodeRequest(
            utterance_id=self._utterance_id,
            kind=kind,
            audio=np.concatenate(self._speech_chunks).astype(np.float32, copy=False),
            started_at_ms=self._started_at_ms,
            ended_at_ms=ended_at_ms,
            sample_rate=self.settings.sample_rate,
            last_voiced_at_ms=self._last_voiced_at_ms,
        )

    def _finish(self, ended_at_ms: float) -> DecodeRequest:
        request = self._snapshot(DecodeKind.FINAL, ended_at_ms)
        self._reset()
        return request

    def _reset(self) -> None:
        self._in_speech = False
        self._speech_chunks = []
        self._pre_roll.clear()
        self._pre_roll_samples = 0
        self._started_at_ms = 0.0
        self._utterance_samples = 0
        self._voiced_samples = 0
        self._silence_samples = 0
        self._since_partial_samples = 0
        self._last_voiced_at_ms = 0.0
