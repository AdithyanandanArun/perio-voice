from __future__ import annotations

from collections.abc import Callable

import numpy as np
import pytest

from server.audio import (
    SEMANTIC_HANGOVER_MAX_MS,
    SEMANTIC_HANGOVER_MIN_MS,
    DecodeKind,
    DecodeRequest,
    SpeechSegmenter,
    SpeechStarted,
    decode_pcm16,
)
from server.config import Settings


def pcm_frame(level: float, milliseconds: int = 100) -> bytes:
    samples = np.full(16 * milliseconds, round(level * 32_767), dtype="<i2")
    return samples.tobytes()


def test_pcm16_validation_and_normalization() -> None:
    with pytest.raises(ValueError, match="even, non-zero"):
        decode_pcm16(b"")
    with pytest.raises(ValueError, match="even, non-zero"):
        decode_pcm16(b"\x01")
    decoded = decode_pcm16(np.array([-32_768, 0, 16_384], dtype="<i2").tobytes())
    assert decoded.tolist() == [-1.0, 0.0, 0.5]


@pytest.mark.parametrize(
    ("factory", "message"),
    [
        (lambda: Settings(sample_rate=8_000), "protocol v1"),
        (lambda: Settings(vad_rms_threshold=0), "between 0 and 1"),
        (lambda: Settings(pre_roll_ms=-1), "cannot be negative"),
        (lambda: Settings(partial_interval_ms=0), "must be positive"),
        (lambda: Settings(max_utterance_ms=100, min_speech_ms=200), "at least"),
        (lambda: Settings(decode_queue_size=0), "at least 1"),
    ],
)
def test_invalid_runtime_settings_fail_fast(factory: Callable[[], Settings], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        factory()


def test_segmenter_emits_start_partial_and_final_with_preroll() -> None:
    settings = Settings(
        vad_rms_threshold=0.02,
        pre_roll_ms=200,
        min_speech_ms=100,
        end_silence_ms=200,
        partial_interval_ms=100,
    )
    segmenter = SpeechSegmenter(settings)

    assert segmenter.feed(pcm_frame(0), 100) == []
    started = segmenter.feed(pcm_frame(0.2), 200)
    assert len(started) == 1
    assert isinstance(started[0], SpeechStarted)

    partial_events = segmenter.feed(pcm_frame(0.2), 400)
    partial = next(event for event in partial_events if isinstance(event, DecodeRequest))
    assert partial.kind is DecodeKind.PARTIAL
    assert partial.audio_ms >= 200

    assert segmenter.feed(pcm_frame(0), 500) == []
    final_events = segmenter.feed(pcm_frame(0), 600)
    final = next(event for event in final_events if isinstance(event, DecodeRequest))
    assert final.kind is DecodeKind.FINAL
    assert final.utterance_id == partial.utterance_id
    assert final.audio_ms >= partial.audio_ms
    assert not segmenter.in_speech


def test_segmenter_flushes_active_audio_and_caps_long_utterances() -> None:
    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=50,
        end_silence_ms=500,
        partial_interval_ms=10_000,
        max_utterance_ms=200,
    )
    segmenter = SpeechSegmenter(settings)
    segmenter.feed(pcm_frame(0.1), 100)
    events = segmenter.feed(pcm_frame(0.1), 350)
    assert any(
        isinstance(event, DecodeRequest) and event.kind is DecodeKind.FINAL for event in events
    )

    segmenter.feed(pcm_frame(0.1), 500)
    flushed = segmenter.flush(600)
    assert flushed is not None
    assert flushed.kind is DecodeKind.FINAL


def test_short_noise_blip_is_not_promoted_by_silent_preroll() -> None:
    settings = Settings(
        vad_rms_threshold=0.02,
        pre_roll_ms=200,
        min_speech_ms=180,
        end_silence_ms=200,
        partial_interval_ms=700,
    )
    segmenter = SpeechSegmenter(settings)
    segmenter.feed(pcm_frame(0), 100)
    segmenter.feed(pcm_frame(0), 200)
    assert any(isinstance(event, SpeechStarted) for event in segmenter.feed(pcm_frame(0.2), 300))
    assert segmenter.feed(pcm_frame(0), 400) == []
    assert segmenter.feed(pcm_frame(0), 500) == []
    assert not segmenter.in_speech


@pytest.mark.parametrize("frame_ms", [20, 40])
def test_low_granularity_frames_preserve_sample_relative_offsets(frame_ms: int) -> None:
    """Twenty- and forty-millisecond packets must retain the same tail audio."""
    settings = Settings(
        vad_rms_threshold=0.02,
        pre_roll_ms=frame_ms * 2,
        min_speech_ms=frame_ms,
        end_silence_ms=frame_ms * 3,
        partial_interval_ms=10_000,
    )
    segmenter = SpeechSegmenter(settings)
    clock = 0
    for _ in range(2):
        clock += frame_ms
        assert segmenter.feed(pcm_frame(0, frame_ms), clock) == []

    started_events = segmenter.feed(pcm_frame(0.2, frame_ms), clock + frame_ms)
    started = next(event for event in started_events if isinstance(event, SpeechStarted))
    assert started.start_sample == 0
    assert started.pre_roll_samples == frame_ms * 2 * 16

    clock += frame_ms
    segmenter.feed(pcm_frame(0.2, frame_ms), clock + frame_ms)
    clock += frame_ms
    segmenter.feed(pcm_frame(0.2, frame_ms), clock + frame_ms)
    final_events: list[object] = []
    for _ in range(3):
        clock += frame_ms
        final_events.extend(segmenter.feed(pcm_frame(0, frame_ms), clock + frame_ms))

    final = next(event for event in final_events if isinstance(event, DecodeRequest))
    assert final.kind is DecodeKind.FINAL
    assert final.start_sample == started.start_sample
    assert final.endpoint_offset_samples == len(final.audio)
    assert final.last_voice_offset_samples < final.endpoint_offset_samples
    assert final.tail_samples == frame_ms * 3 * 16
    assert final.endpoint_offset_samples % (frame_ms * 16) == 0


def test_semantic_complete_hint_uses_short_hangover_only_when_supplied() -> None:
    settings = Settings(
        vad_rms_threshold=0.02,
        pre_roll_ms=0,
        min_speech_ms=40,
        end_silence_ms=520,
        partial_interval_ms=10_000,
    )
    hinted = SpeechSegmenter(settings)
    clock = 0
    for _ in range(3):
        clock += 40
        hinted.feed(pcm_frame(0.2, 40), clock)
    for _ in range(4):
        clock += 40
        events = hinted.feed(pcm_frame(0, 40), clock, semantic_complete_hint=True)
    final = next(event for event in events if isinstance(event, DecodeRequest))
    assert final.kind is DecodeKind.FINAL
    assert SEMANTIC_HANGOVER_MIN_MS <= final.tail_samples / 16 <= SEMANTIC_HANGOVER_MAX_MS

    ordinary = SpeechSegmenter(settings)
    clock = 0
    for _ in range(3):
        clock += 40
        ordinary.feed(pcm_frame(0.2, 40), clock)
    for _ in range(4):
        clock += 40
        assert ordinary.feed(pcm_frame(0, 40), clock) == []
    assert ordinary.in_speech


def test_pre_speech_semantic_hint_does_not_leak_into_next_utterance() -> None:
    settings = Settings(
        vad_rms_threshold=0.02,
        pre_roll_ms=80,
        min_speech_ms=40,
        end_silence_ms=520,
        partial_interval_ms=10_000,
    )
    segmenter = SpeechSegmenter(settings)
    assert segmenter.feed(pcm_frame(0, 40), 40, semantic_complete_hint=True) == []
    assert not segmenter.semantic_complete_hint

    started = segmenter.feed(pcm_frame(0.2, 40), 80)
    assert any(isinstance(event, SpeechStarted) for event in started)
    assert not segmenter.semantic_complete_hint
    for index in range(4):
        assert segmenter.feed(pcm_frame(0, 40), 120 + index * 40) == []
    assert segmenter.in_speech


def test_audio_gap_resets_buffer_and_advances_sample_clock() -> None:
    settings = Settings(
        vad_rms_threshold=0.02,
        pre_roll_ms=80,
        min_speech_ms=40,
        end_silence_ms=200,
        partial_interval_ms=10_000,
    )
    segmenter = SpeechSegmenter(settings)
    assert any(isinstance(event, SpeechStarted) for event in segmenter.feed(pcm_frame(0.2, 40), 40))
    assert segmenter.in_speech

    segmenter.reset_for_gap(2_000)
    assert not segmenter.in_speech
    assert segmenter.stream_samples == 2_000

    restarted = segmenter.feed(pcm_frame(0.2, 40), 200)
    start = next(event for event in restarted if isinstance(event, SpeechStarted))
    assert start.start_sample == 2_000
