"""Local, revocable speaker attribution.

The dentist is not the only person speaking in an operatory. A patient saying
"it hurts around number four" must not be able to write a measurement, and
neither must an assistant. Recognition accuracy does not help: the words can be
transcribed perfectly and still not belong in the record.

This module implements classical speaker verification with no extra dependency,
no model download and no network call. The enrolled clinician is described by
two views of their voice, and an utterance is accepted only when it matches
*both*:

1. the long-term average log-mel spectrum, which captures vocal tract shape;
2. the mean and spread of the cepstral coefficients, which capture how that
   shape moves during speech.

Requiring both agreement scores to clear the bar is what gives the gate its
margin. On the checked-in speech fixture, held-out speech from the enrolled
speaker scores at or above 0.989 on both views while a deliberately hard
negative — the same recording resampled so pitch and formants move together,
which keeps the original speaking style — never exceeds 0.939 on both. The
default thresholds sit inside that gap, and `scripts/calibrate_speaker.py`
re-measures it.

The limits are real and are stated in ARCHITECTURE.md. A spectral profile is not
a biometric identity claim; it separates clearly different voices, and for
anything in between it reports `unknown` so the pipeline asks a human instead of
guessing. Pitch was evaluated as a third view and deliberately left out: median
F0 varies by more than fifteen percent between five-second segments of one
speaker, which is the same order as the difference it would need to detect.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Final

import numpy as np
from numpy.typing import NDArray

from server.config import Settings

FloatAudio = NDArray[np.float32]

FRAME_MS: Final = 40
HOP_MS: Final = 10
MEL_FILTERS: Final = 40
CEPSTRA: Final = 13
LOW_HZ: Final = 80.0
HIGH_HZ: Final = 7000.0
FFT_SIZE: Final = 1024
"""Absolute RMS floor for a frame to count as speech.

This used to be a fraction of the loudest frame in the clip, which failed badly:
speech has wide dynamic range, so a peak-relative bar discards roughly a third of
genuine speech, and one loud transient suppresses everything after it. Six
seconds of continuous speech yielded only 1,870 ms of "voiced" audio against a
2,000 ms enrollment requirement, which is why enrollment appeared to need
shouting. An absolute floor with a much smaller relative component is stable
against both level and transients."""
VOICED_RMS_FLOOR: Final = 0.006
"""Small relative component, so a very loud recording is not entirely voiced."""
VOICED_PEAK_RATIO: Final = 0.02


class SpeakerDecision(StrEnum):
    CLINICIAN = "clinician"
    OTHER = "other"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class SpeakerVerdict:
    decision: SpeakerDecision
    similarity: float
    enrolled: bool
    voiced_ms: int
    spectral: float = 0.0
    cepstral: float = 0.0

    def as_message(self) -> dict[str, object]:
        return {
            "decision": self.decision.value,
            "similarity": round(self.similarity, 4),
            "spectral": round(self.spectral, 4),
            "cepstral": round(self.cepstral, 4),
            "enrolled": self.enrolled,
            "voicedMs": self.voiced_ms,
        }


@dataclass(frozen=True, slots=True)
class EnrollmentState:
    enrolled: bool
    samples: int
    voiced_ms: int
    required_ms: int = 0

    def as_message(self) -> dict[str, object]:
        return {
            "enrolled": self.enrolled,
            "samples": self.samples,
            "voicedMs": self.voiced_ms,
            "requiredMs": self.required_ms,
        }


@dataclass(frozen=True, slots=True)
class VoiceProfile:
    """Two complementary views of one voice."""

    spectral: NDArray[np.float32]
    cepstral: NDArray[np.float32]
    voiced_ms: int


def _hz_to_mel(hz: float) -> float:
    return 2595.0 * float(np.log10(1.0 + hz / 700.0))


def _mel_to_hz(mel: float) -> float:
    return float(700.0 * (10.0 ** (mel / 2595.0) - 1.0))


def _mel_filterbank(sample_rate: int) -> NDArray[np.float32]:
    edges = np.linspace(
        _hz_to_mel(LOW_HZ), _hz_to_mel(min(HIGH_HZ, sample_rate / 2)), MEL_FILTERS + 2
    )
    hz = np.array([_mel_to_hz(edge) for edge in edges])
    bins = np.clip(np.floor((FFT_SIZE + 1) * hz / sample_rate).astype(int), 0, FFT_SIZE // 2)
    filters = np.zeros((MEL_FILTERS, FFT_SIZE // 2 + 1), dtype=np.float32)
    for index in range(MEL_FILTERS):
        left = int(bins[index])
        centre = max(int(bins[index + 1]), left + 1)
        right = max(int(bins[index + 2]), centre + 1)
        right = min(right, FFT_SIZE // 2)
        centre = min(centre, max(right - 1, left + 1))
        for bin_index in range(left, centre):
            filters[index, bin_index] = (bin_index - left) / max(1, centre - left)
        for bin_index in range(centre, right):
            filters[index, bin_index] = (right - bin_index) / max(1, right - centre)
    return filters


def _dct_matrix() -> NDArray[np.float32]:
    basis = np.zeros((CEPSTRA, MEL_FILTERS), dtype=np.float32)
    for k in range(CEPSTRA):
        for n in range(MEL_FILTERS):
            basis[k, n] = np.cos(np.pi * k * (2 * n + 1) / (2 * MEL_FILTERS))
    return basis


_FILTERS: dict[int, NDArray[np.float32]] = {}
_DCT = _dct_matrix()


def _filters_for(sample_rate: int) -> NDArray[np.float32]:
    cached = _FILTERS.get(sample_rate)
    if cached is None:
        cached = _mel_filterbank(sample_rate)
        _FILTERS[sample_rate] = cached
    return cached


def _frame(audio: FloatAudio, frame_len: int, hop: int) -> NDArray[np.float32]:
    if len(audio) < frame_len:
        padded = np.zeros(frame_len, dtype=np.float32)
        padded[: len(audio)] = audio
        return padded.reshape(1, frame_len)
    count = 1 + (len(audio) - frame_len) // hop
    indices = np.arange(frame_len)[None, :] + hop * np.arange(count)[:, None]
    framed: NDArray[np.float32] = audio[indices].astype(np.float32, copy=False)
    return framed


def profile(audio: FloatAudio, sample_rate: int) -> VoiceProfile:
    """Builds both views of a voice from one stretch of audio."""
    frame_len = int(sample_rate * FRAME_MS / 1000)
    hop = int(sample_rate * HOP_MS / 1000)
    frames = _frame(np.asarray(audio, dtype=np.float32), frame_len, hop)
    windowed = frames * np.hanning(frame_len).astype(np.float32)

    rms = np.sqrt(np.mean(np.square(windowed), axis=1))
    peak = float(np.max(rms)) if rms.size else 0.0
    threshold = max(VOICED_RMS_FLOOR, peak * VOICED_PEAK_RATIO)
    voiced = rms >= threshold
    if not bool(np.any(voiced)):
        voiced = np.ones(len(frames), dtype=bool)

    spectrum = np.abs(np.fft.rfft(windowed, n=FFT_SIZE)) ** 2
    mel = np.log(np.maximum(spectrum @ _filters_for(sample_rate).T, 1e-10))
    spectral = np.asarray(mel[voiced].mean(axis=0), dtype=np.float32)

    cepstra = (mel @ _DCT.T)[voiced][:, 1:CEPSTRA]
    cepstral = np.concatenate(
        [cepstra.mean(axis=0), cepstra.std(axis=0)],
    ).astype(np.float32)

    voiced_ms = round(float(np.sum(voiced)) * HOP_MS)
    return VoiceProfile(spectral, cepstral, voiced_ms)


def correlation(left: NDArray[np.float32], right: NDArray[np.float32]) -> float:
    """Pearson correlation, so an overall level difference cannot mask shape."""
    centred_left = left - float(np.mean(left))
    centred_right = right - float(np.mean(right))
    denominator = float(np.linalg.norm(centred_left) * np.linalg.norm(centred_right))
    if denominator == 0:
        return 0.0
    return float(np.dot(centred_left, centred_right) / denominator)


class SpeakerGate:
    """Holds one enrolled clinician profile for the lifetime of the process."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._spectral: NDArray[np.float32] | None = None
        self._cepstral: NDArray[np.float32] | None = None
        self._samples = 0
        self._voiced_ms = 0
        self._window: list[FloatAudio] = []
        self._window_samples = 0

    @property
    def enrolled(self) -> bool:
        """Enrolled once enough speech has accumulated, across any number of takes."""
        return self._spectral is not None and self._voiced_ms >= self.settings.speaker_enroll_ms

    def state(self) -> EnrollmentState:
        return EnrollmentState(
            self.enrolled, self._samples, self._voiced_ms, self.settings.speaker_enroll_ms
        )

    def reset(self) -> EnrollmentState:
        """Revokes the stored profile. Enrollment data never leaves this process."""
        self._spectral = None
        self._cepstral = None
        self._samples = 0
        self._voiced_ms = 0
        self.forget_window()
        return self.state()

    def forget_window(self) -> None:
        """Drops accumulated verification audio, e.g. when a stream ends."""
        self._window = []
        self._window_samples = 0

    def _remember(self, audio: FloatAudio) -> FloatAudio:
        """Keeps a trailing window of recent speech for attribution.

        A single clinical utterance is far too short to attribute. Measured
        against a six-second enrollment, the same speaker and a different speaker
        are indistinguishable below about two seconds and actually invert below
        one: at 0.5 s the enrolled speaker scored 0.766 while another voice
        scored 0.963. Separation only becomes usable around four seconds.

        Who is holding the microphone does not change between utterances, so the
        window is the right unit to judge, not the utterance.
        """
        limit = round(self.settings.sample_rate * self.settings.speaker_window_ms / 1_000)
        self._window.append(audio)
        self._window_samples += len(audio)
        # Keep at least the most recent chunk: a single clip longer than the
        # window would otherwise empty the buffer entirely.
        while len(self._window) > 1 and self._window_samples > limit * 2:
            removed = self._window.pop(0)
            self._window_samples -= len(removed)
        combined = np.concatenate(self._window).astype(np.float32, copy=False)
        return combined[-limit:] if len(combined) > limit else combined

    def enroll(self, audio: FloatAudio) -> EnrollmentState:
        """Folds one take into the profile.

        Takes accumulate rather than each having to be sufficient on its own, so
        the interface can show progress toward the target and the clinician can
        simply speak again instead of being told a whole recording was wasted.
        """
        voice = profile(audio, self.settings.sample_rate)
        if voice.voiced_ms < self.settings.speaker_min_ms:
            raise ValueError(
                f"That take contained {voice.voiced_ms} ms of speech, which is too "
                f"little to use. Speak continuously for a few seconds."
            )
        if self._spectral is None or self._cepstral is None:
            self._spectral = voice.spectral
            self._cepstral = voice.cepstral
        else:
            # Weight by speech duration: a longer take describes the voice better.
            weight = float(self._voiced_ms)
            total = weight + voice.voiced_ms
            self._spectral = (self._spectral * weight + voice.spectral * voice.voiced_ms) / total
            self._cepstral = (self._cepstral * weight + voice.cepstral * voice.voiced_ms) / total
        self._samples += 1
        self._voiced_ms += voice.voiced_ms
        return self.state()

    def verify(self, audio: FloatAudio) -> SpeakerVerdict:
        """Attributes the current speaker using recent speech, not one utterance."""
        if not self.enrolled or self._spectral is None or self._cepstral is None:
            return SpeakerVerdict(SpeakerDecision.UNKNOWN, 0.0, False, 0)
        window = self._remember(audio)
        voice = profile(window, self.settings.sample_rate)
        if voice.voiced_ms < self.settings.speaker_min_ms:
            # Too little voice to judge. Saying so beats a coin flip.
            return SpeakerVerdict(SpeakerDecision.UNKNOWN, 0.0, True, voice.voiced_ms)
        spectral = correlation(voice.spectral, self._spectral)
        cepstral = correlation(voice.cepstral, self._cepstral)
        # Both views must agree, so a voice that happens to match one of them is
        # still not accepted.
        similarity = min(spectral, cepstral)
        if similarity >= self.settings.speaker_accept:
            decision = SpeakerDecision.CLINICIAN
        elif similarity <= self.settings.speaker_reject:
            decision = SpeakerDecision.OTHER
        else:
            decision = SpeakerDecision.UNKNOWN
        return SpeakerVerdict(decision, similarity, True, voice.voiced_ms, spectral, cepstral)
