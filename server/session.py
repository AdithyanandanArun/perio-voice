from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Any

from server.audio import DecodeKind, DecodeRequest, SpeechSegmenter, SpeechStarted
from server.cadence import CadenceController
from server.config import Settings
from server.denoise import apply_profile
from server.grammar_recognizer import VoskGrammarSession
from server.recognizer import ModelStatus, RecognitionResult, Recognizer
from server.routed_recognizer import RoutedRecognizer
from server.speaker import SpeakerGate
from server.speech_presence import assess
from server.telemetry import Telemetry
from server.vocabulary import Expectation, is_structurally_complete

SendMessage = Callable[[dict[str, Any]], Awaitable[None]]


def monotonic_ms() -> float:
    return time.monotonic() * 1_000


@dataclass(slots=True)
class _UtteranceState:
    """Identity and lifecycle state that survives queue reordering."""

    utterance_id: int
    stream_id: str | None
    transaction_id: str
    original_context_version: int | None
    start_sample: int
    started_at_ms: float
    revision: int = 0
    endpoint_sent: bool = False
    invalid: bool = False
    semantic_complete: bool = False
    last_fast_text: str = ""


class AsrSession:
    """One browser stream with bounded, latest-partial-wins decoding.

    The session owns everything that has to happen per utterance and in order:
    endpointing, backpressure, preprocessing, recognition, speaker attribution
    and the cadence feedback that moves the endpoint for the next utterance.

    A Vosk session, when available, is intentionally a hint-only side channel.
    It may publish a provisional partial and shorten the segmenter's hangover,
    but every chart-eligible final still comes from ``self.recognizer``.
    """

    def __init__(
        self,
        recognizer: Recognizer,
        settings: Settings,
        send: SendMessage,
        *,
        telemetry: Telemetry | None = None,
        speaker_gate: SpeakerGate | None = None,
        stream_id: str | None = None,
        original_context_version: int | None = None,
        context_version: int | None = None,
        expectation: Expectation = Expectation.CLINICAL,
    ) -> None:
        self.recognizer = recognizer
        self.settings = settings
        self.send = send
        self.segmenter = SpeechSegmenter(settings)
        self.cadence = CadenceController(settings)
        self.telemetry = telemetry or Telemetry()
        self.speaker_gate = speaker_gate
        self._stream_id = self._clean_stream_id(stream_id)
        self._context_version = (
            original_context_version if original_context_version is not None else context_version
        )
        self._expectation = expectation
        self._queue: asyncio.Queue[DecodeRequest | None] = asyncio.Queue(
            maxsize=settings.decode_queue_size
        )
        self._worker: asyncio.Task[None] | None = None
        self._closed = False
        self._dropped_partials = 0
        self._active_utterance_id: int | None = None
        self._utterances: dict[int, _UtteranceState] = {}
        self._grammar_session: VoskGrammarSession | None = None
        self._grammar_utterance_id: int | None = None
        self._grammar_semantic_complete = False
        # Structural stability: the same clinically-complete partial must
        # repeat on a second consecutive grammar feed before it can latch the
        # semantic hint, so a partial still growing word-by-word
        # ("three", "three four", "three four five") cannot fire on its first,
        # in-progress-looking stop. Reset whenever a grammar session opens.
        self._grammar_last_stable_text = ""
        if isinstance(self.recognizer, RoutedRecognizer):
            self.recognizer.set_expectation(expectation)

    @staticmethod
    def _clean_stream_id(value: object) -> str | None:
        if not isinstance(value, str):
            return None
        cleaned = value.strip()
        if not cleaned:
            return None
        return cleaned

    async def start(self) -> None:
        if self._worker is None:
            self.telemetry.count("streams_started")
            self._worker = asyncio.create_task(self._decode_loop(), name="asr-session-decode")

    async def feed(self, payload: bytes, received_at_ms: float | None = None) -> None:
        if self._closed:
            raise RuntimeError("Cannot feed a closed ASR session.")
        timestamp = received_at_ms if received_at_ms is not None else monotonic_ms()

        # Feed the already-open grammar before endpointing the next frame. A
        # semantic result can therefore select the 120--200 ms hangover for the
        # silence frame that follows it. The first speech frame is handled below
        # after the segmenter emits SpeechStarted.
        grammar_result: RecognitionResult | None = None
        semantic_hint = False
        if self.segmenter.in_speech and self._grammar_session is not None:
            grammar_result = await self._feed_grammar(payload)
            semantic_hint = self._grammar_is_complete(
                grammar_result,
                completed=self._grammar_semantic_complete,
            )
            active_id = self._active_utterance_id
            active_state = self._utterances.get(active_id) if active_id is not None else None
            if semantic_hint and active_state is not None:
                self._mark_semantic_complete(active_state)

        events = self.segmenter.feed(
            payload,
            timestamp,
            semantic_complete_hint=semantic_hint,
        )
        for event in events:
            if isinstance(event, SpeechStarted):
                state = self._new_utterance(event)
                self._active_utterance_id = event.utterance_id
                self.telemetry.count("utterances_total")
                await self.send(
                    {
                        "type": "speech_start",
                        **self._identity(state),
                        "lifecycle": "provisional",
                        "recognitionPath": "endpointing",
                        "startedAtMs": round(event.started_at_ms, 2),
                        "sampleRate": self.settings.sample_rate,
                        "startSample": event.start_sample,
                        "endSample": event.start_sample,
                        "durationSamples": 0,
                    }
                )

                # Opening is lazy so a stream that only contains silence never
                # loads Vosk. If it is unavailable, the terminal path remains
                # usable; the fast hint is an optimization, not clinical truth.
                await self._open_grammar(event.utterance_id)
                if grammar_result is None:
                    grammar_result = await self._feed_grammar(payload)
                if self._grammar_is_complete(
                    grammar_result,
                    completed=self._grammar_semantic_complete,
                ):
                    self._mark_semantic_complete(state)
                    self.segmenter.set_semantic_complete_hint()
            else:
                state = self._state_for_request(event)
                if event.kind is DecodeKind.PARTIAL:
                    if grammar_result is not None and grammar_result.text.strip():
                        await self._emit_fast_partial(event, grammar_result)
                    elif not state.semantic_complete:
                        # A latched semantic hint means the endpoint is
                        # imminent (F10): starting a terminal Whisper decode
                        # here would sit in the single-consumer queue ahead of
                        # the final that is about to follow, and the decode
                        # lock in server/recognizer.py cannot preempt it once
                        # started. Measured endpoint-to-final p95 regressed
                        # 338 -> 571 ms from exactly this queuing, so a
                        # semantically complete utterance skips the terminal
                        # partial rather than compete with its own final.
                        await self._enqueue(event)
                    continue

                # The endpoint is a boundary event, not a side effect of the
                # final decode. The client can measure endpoint-to-final while
                # the expensive terminal recognizer runs in the worker.
                await self._emit_endpoint(event)
                await self._close_grammar()
                self._active_utterance_id = None
                await self._enqueue(event)

    async def stop(self, received_at_ms: float | None = None) -> None:
        if self._closed:
            return
        timestamp = received_at_ms if received_at_ms is not None else monotonic_ms()
        final = self.segmenter.flush(timestamp)
        if final is not None:
            await self._emit_endpoint(final)
            await self._close_grammar()
            self._active_utterance_id = None
            await self._enqueue(final)
        else:
            # ``flush`` resets a too-short segment as well. Do not leave its
            # grammar recognizer alive waiting for an impossible final.
            self._active_utterance_id = None
            await self._close_grammar()
        await self._queue.join()
        await self.send({"type": "stopped", "droppedPartials": self._dropped_partials})

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._close_grammar()
        self._discard_pending_requests(include_final=True)
        self._utterances.clear()
        self._active_utterance_id = None
        if self._worker is not None:
            # Cancellation is exact for the session task and avoids keeping a
            # worker alive after a browser disconnect. The decode loop marks an
            # item done in its finally block even when cancellation lands during
            # a recognizer await.
            worker = self._worker
            self._worker = None
            worker.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await worker
        self._discard_pending_requests(include_final=True)

    async def handle_audio_gap(
        self,
        *,
        stream_id: str,
        sample_rate: int,
        start_sample: int,
        end_sample: int,
    ) -> dict[str, Any]:
        """Validate and apply an ordered missing-audio marker.

        The active utterance is invalidated, not flushed into a terminal decode.
        This is deliberately fail-closed: a gap may lose a chartable utterance,
        but it can never join samples from either side into a fabricated one.
        """
        incoming_stream = self._clean_stream_id(stream_id)
        if incoming_stream is None:
            self.telemetry.count("audio_gaps_rejected")
            raise ValueError("Audio gap streamId must be a non-empty string.")
        if self._stream_id is not None and incoming_stream != self._stream_id:
            self.telemetry.count("audio_gaps_rejected")
            raise ValueError("Audio gap streamId does not match the active stream.")
        if self._stream_id is None:
            self._stream_id = incoming_stream
        if (
            isinstance(sample_rate, bool)
            or not isinstance(sample_rate, int)
            or sample_rate != self.settings.sample_rate
        ):
            self.telemetry.count("audio_gaps_rejected")
            raise ValueError(f"Audio gap sampleRate must be {self.settings.sample_rate}.")
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in (start_sample, end_sample)
        ):
            self.telemetry.count("audio_gaps_rejected")
            raise ValueError("Audio gap samples must be non-negative integers.")
        if end_sample <= start_sample:
            self.telemetry.count("audio_gaps_rejected")
            raise ValueError("Audio gap endSample must be greater than startSample.")
        if start_sample != self.segmenter.stream_samples:
            self.telemetry.count("audio_gaps_rejected")
            raise ValueError("Audio gap startSample must equal the next expected stream sample.")

        active_id = self._active_utterance_id if self.segmenter.in_speech else None
        if active_id is not None:
            state = self._utterances.get(active_id)
            if state is not None:
                state.invalid = True
            self._discard_pending_requests(active_id, include_final=True)
            self._utterances.pop(active_id, None)
        self.segmenter.reset_for_gap(end_sample)
        self._active_utterance_id = None
        await self._close_grammar()
        self.telemetry.count("audio_gaps")
        self.telemetry.observe("audio_gap_samples", float(end_sample - start_sample))
        return {
            "type": "audio_gap_ack",
            "streamId": incoming_stream,
            "sampleRate": self.settings.sample_rate,
            "startSample": start_sample,
            "endSample": end_sample,
            "recoverable": True,
            "droppedPartials": self._dropped_partials,
        }

    async def _open_grammar(self, utterance_id: int) -> None:
        if self._grammar_session is not None:
            return
        if not isinstance(self.recognizer, RoutedRecognizer):
            return
        if self._expectation is Expectation.FREE:
            return
        if self.recognizer.grammar.status is ModelStatus.ERROR:
            return
        try:
            self._grammar_session = await self.recognizer.start_grammar_session(self._expectation)
            self._grammar_utterance_id = utterance_id
            self._grammar_semantic_complete = False
            self._grammar_last_stable_text = ""
            self.telemetry.count("grammar_sessions_opened")
        except asyncio.CancelledError:
            raise
        except Exception:
            # Vosk is an optional fast side channel. A missing model must not
            # turn a valid terminal Whisper deployment into a grammar final.
            self.telemetry.count("grammar_session_errors")
            self._grammar_session = None
            self._grammar_utterance_id = None
            self._grammar_semantic_complete = False
            self._grammar_last_stable_text = ""

    async def _feed_grammar(self, payload: bytes) -> RecognitionResult | None:
        session = self._grammar_session
        if session is None:
            return None
        try:
            result = await session.feed_pcm(payload)
            # Vosk's own AcceptWaveform/word-timing completion is kept as a
            # slower fallback signal (see module docstring): the structural
            # check is what actually beats Vosk's ~500 ms endpointer.
            vosk_complete = bool(getattr(session, "semantic_complete", False) or result.words)
            self._grammar_semantic_complete = vosk_complete or self._structural_hint(result)
            return result
        except asyncio.CancelledError:
            raise
        except Exception:
            self.telemetry.count("grammar_session_errors")
            await self._close_grammar()
            return None

    def _structural_hint(self, result: RecognitionResult) -> bool:
        """Latch only on a clinically complete partial seen twice in a row.

        Structural completeness (server.vocabulary.is_structurally_complete)
        decides *what* would be a whole clinical unit; this decides *when* it
        is safe to believe -- an unknown token or a still-growing partial must
        never latch, and a partial that changes to a different complete text
        restarts the stability count rather than latching immediately.
        """
        text = result.text.strip()
        previous = self._grammar_last_stable_text
        self._grammar_last_stable_text = text
        if not text or result.unknown_ratio > 0.0:
            return False
        if not is_structurally_complete(text, self._expectation):
            return False
        return text == previous

    async def _close_grammar(self) -> None:
        session = self._grammar_session
        if session is None:
            return
        self._grammar_session = None
        self._grammar_utterance_id = None
        self._grammar_semantic_complete = False
        self._grammar_last_stable_text = ""
        try:
            close = getattr(session, "close", None)
            if callable(close):
                close()
        finally:
            self.telemetry.count("grammar_sessions_closed")

    @staticmethod
    def _grammar_is_complete(
        result: RecognitionResult | None,
        *,
        completed: bool = False,
    ) -> bool:
        if result is None or not result.text.strip():
            return False
        # A partial grammar string is useful for the provisional UI but must not
        # shorten endpointing. Only Vosk's accepted phrase (or emitted words
        # observed by ``_feed_grammar``) may latch the short hangover. Unknown-
        # only output is cleaned to an empty string; retain a conservative ratio
        # guard for mixed outputs from older Vosk builds.
        return completed and result.unknown_ratio < 0.75

    def _mark_semantic_complete(self, state: _UtteranceState) -> None:
        if state.semantic_complete:
            return
        state.semantic_complete = True
        self.telemetry.count("semantic_hints")

    def _new_utterance(self, event: SpeechStarted) -> _UtteranceState:
        stream_id = self._stream_id
        transaction_id = (
            f"{stream_id}:{event.utterance_id}"
            if stream_id is not None
            else f"legacy:{event.utterance_id}"
        )
        state = _UtteranceState(
            utterance_id=event.utterance_id,
            stream_id=stream_id,
            transaction_id=transaction_id,
            original_context_version=self._context_version,
            start_sample=event.start_sample,
            started_at_ms=event.started_at_ms,
            revision=1,
        )
        self._utterances[event.utterance_id] = state
        return state

    def _state_for_request(self, request: DecodeRequest) -> _UtteranceState:
        state = self._utterances.get(request.utterance_id)
        if state is not None:
            return state
        # Direct worker tests and legacy callers may enqueue a request without a
        # preceding SpeechStarted event. Keep those calls safe and additive.
        stream_id = self._stream_id
        state = _UtteranceState(
            utterance_id=request.utterance_id,
            stream_id=stream_id,
            transaction_id=(
                f"{stream_id}:{request.utterance_id}"
                if stream_id is not None
                else f"legacy:{request.utterance_id}"
            ),
            original_context_version=self._context_version,
            start_sample=request.start_sample,
            started_at_ms=request.started_at_ms,
        )
        self._utterances[request.utterance_id] = state
        return state

    @staticmethod
    def _identity(state: _UtteranceState) -> dict[str, Any]:
        return {
            "streamId": state.stream_id,
            "utteranceId": state.utterance_id,
            "transactionId": state.transaction_id,
            "revision": state.revision,
            "originalContextVersion": state.original_context_version,
        }

    @staticmethod
    def _sample_timing(request: DecodeRequest) -> dict[str, int]:
        start_sample = max(0, int(request.start_sample))
        end_sample = int(request.end_sample)
        if end_sample <= start_sample:
            end_sample = start_sample + len(request.audio)
        # Clamped defensively so a strict downstream timing gate never sees
        # lastVoiceSample fall outside [startSample, endSample] even if a
        # future segmenter change produces a boundary value.
        last_voice_sample = min(max(int(request.last_voice_sample), start_sample), end_sample)
        return {
            "sampleRate": int(request.sample_rate),
            "startSample": start_sample,
            "endSample": end_sample,
            "durationSamples": max(0, end_sample - start_sample),
            "lastVoiceSample": last_voice_sample,
        }

    def _next_revision(self, state: _UtteranceState) -> int:
        state.revision = max(0, state.revision) + 1
        return state.revision

    async def _emit_endpoint(self, request: DecodeRequest) -> None:
        state = self._state_for_request(request)
        if state.endpoint_sent:
            return
        state.endpoint_sent = True
        self.telemetry.count("endpoints_total")
        await self.send(
            {
                "type": "endpoint",
                **self._identity_with_revision(state),
                "lifecycle": "provisional",
                "recognitionPath": "terminal",
                "audioMs": request.audio_ms,
                "startedAtMs": round(request.started_at_ms, 2),
                "endedAtMs": round(request.ended_at_ms, 2),
                "endpointReason": request.endpoint_reason,
                **self._sample_timing(request),
            }
        )

    def _identity_with_revision(self, state: _UtteranceState) -> dict[str, Any]:
        self._next_revision(state)
        return self._identity(state)

    async def _emit_fast_partial(
        self,
        request: DecodeRequest,
        result: RecognitionResult,
    ) -> None:
        state = self._state_for_request(request)
        if state.invalid or state.endpoint_sent:
            return
        text = result.text.strip()
        if not text or text == state.last_fast_text:
            return
        state.last_fast_text = text
        self.telemetry.count("partials_total")
        self.telemetry.count("grammar_partials")
        self.telemetry.observe("decode_ms_partial", result.decode_ms)
        self.telemetry.observe("audio_ms", request.audio_ms)
        await self.send(
            {
                "type": "partial",
                **self._identity_with_revision(state),
                "text": text,
                "lifecycle": "provisional",
                "recognitionPath": "fast",
                "engine": "grammar",
                "audioMs": request.audio_ms,
                "decodeMs": result.decode_ms,
                "startedAtMs": round(request.started_at_ms, 2),
                "endedAtMs": round(request.ended_at_ms, 2),
                "droppedPartials": self._dropped_partials,
                "unknownRatio": round(result.unknown_ratio, 4),
                "alternatives": [
                    {"text": item.text, "confidence": item.confidence}
                    for item in result.alternatives
                    if item.text
                ],
                **self._sample_timing(request),
            }
        )

    async def _enqueue(self, request: DecodeRequest) -> None:
        stamped = replace(request, queued_at_ms=monotonic_ms())
        if stamped.kind is DecodeKind.PARTIAL:
            self._discard_pending_partials()
            if self._queue.full():
                self._dropped_partials += 1
                self.telemetry.count("partials_dropped")
                return
            self._queue.put_nowait(stamped)
            return

        self._discard_pending_partials()
        await self._queue.put(stamped)

    def _discard_pending_partials(self) -> None:
        self._discard_pending_requests(include_final=False)

    def _discard_pending_requests(
        self,
        utterance_id: int | None = None,
        *,
        include_final: bool = False,
    ) -> None:
        retained: list[DecodeRequest | None] = []
        while True:
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if (
                isinstance(item, DecodeRequest)
                and (utterance_id is None or item.utterance_id == utterance_id)
                and (include_final or item.kind is DecodeKind.PARTIAL)
            ):
                if item.kind is DecodeKind.PARTIAL:
                    self._dropped_partials += 1
                    self.telemetry.count("partials_dropped")
                self._queue.task_done()
            else:
                # ``get_nowait`` removes an unfinished item. Mark that
                # occurrence done before putting it back so retaining a final
                # (or the sentinel) does not inflate Queue.join's accounting.
                self._queue.task_done()
                retained.append(item)
        for item in retained:
            self._queue.put_nowait(item)

    async def _decode_loop(self) -> None:
        while True:
            request = await self._queue.get()
            try:
                if request is None:
                    return
                await self._decode(request)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.telemetry.count("decode_errors")
                # A final that raises (apply_profile or recognizer.transcribe)
                # must still free its utterance state. The success and guard
                # paths pop it themselves after sending; this is the one path
                # that never reaches either, so without this the entry is
                # never removed and repeated failures grow ``_utterances``
                # without bound. ``pop(..., None)`` is idempotent, so this is
                # safe even if the state was already released elsewhere.
                if isinstance(request, DecodeRequest) and request.kind is DecodeKind.FINAL:
                    self._utterances.pop(request.utterance_id, None)
                with contextlib.suppress(Exception):
                    await self.send(
                        {
                            "type": "error",
                            "code": "decode_failed",
                            "recoverable": True,
                            "message": f"Recognition failed: {exc}",
                        }
                    )
            finally:
                self._queue.task_done()

    async def _decode(self, request: DecodeRequest) -> None:
        state = self._state_for_request(request)
        if state.invalid:
            return
        final = request.kind is DecodeKind.FINAL
        if request.queued_at_ms:
            self.telemetry.observe("queue_wait_ms", max(0.0, monotonic_ms() - request.queued_at_ms))

        # Every model tested hallucinates confident words on sub-half-second
        # audio, so the cheapest defence is not to ask it.
        if final and request.audio_ms < self.settings.min_final_ms:
            self.telemetry.count("finals_rejected_short")
            await self._send_guard_final(request, state, reason="too_short")
            return

        # A prompted recognizer given noise recites its prompt, so whether this
        # is speech at all is decided here, by a model that never sees the prompt.
        presence: float | None = None
        if self.settings.speech_presence_threshold > 0:
            assessment = await asyncio.to_thread(assess, request.audio)
            presence = assessment.probability
            if state.invalid or (not final and state.endpoint_sent):
                return
            if not assessment.is_speech(self.settings.speech_presence_threshold):
                if not final:
                    self.telemetry.count("partials_skipped_no_speech_presence")
                    return
                self.telemetry.count("finals_rejected_no_speech_presence")
                await self._send_guard_final(
                    request,
                    state,
                    reason=assessment.reason,
                    speech_presence=presence,
                )
                return

        if not final and state.endpoint_sent:
            return
        audio = apply_profile(request.audio, request.sample_rate, self.settings.denoise_profile)
        result = await self.recognizer.transcribe(audio, partial=not final)

        # A gap can arrive while the terminal recognizer is in flight. Its
        # result is then discarded rather than crossing the missing range.
        if state.invalid or (not final and state.endpoint_sent):
            return

        self.telemetry.count("finals_total" if final else "partials_total")
        self.telemetry.observe(
            "decode_ms_final" if final else "decode_ms_partial", result.decode_ms
        )
        self.telemetry.observe("audio_ms", request.audio_ms)

        rejected = final and result.no_speech_prob > self.settings.no_speech_threshold
        if rejected:
            self.telemetry.count("finals_rejected_no_speech")

        if not final:
            await self.send(
                {
                    "type": "partial",
                    **self._identity_with_revision(state),
                    "text": "" if rejected else result.text,
                    "lifecycle": "provisional",
                    "recognitionPath": "terminal",
                    "engine": result.engine,
                    "audioMs": request.audio_ms,
                    "decodeMs": result.decode_ms,
                    "startedAtMs": round(request.started_at_ms, 2),
                    "endedAtMs": round(request.ended_at_ms, 2),
                    "droppedPartials": self._dropped_partials,
                    "unknownRatio": round(result.unknown_ratio, 4),
                    "noSpeechProb": round(result.no_speech_prob, 4),
                    "alternatives": [
                        {"text": item.text, "confidence": item.confidence}
                        for item in result.alternatives
                        if item.text
                    ],
                    **({"speechPresence": round(presence, 4)} if presence is not None else {}),
                    **self._sample_timing(request),
                }
            )
            return

        message: dict[str, Any] = {
            "type": "final",
            **self._identity_with_revision(state),
            "text": "" if rejected else result.text,
            "lifecycle": "confirmed",
            "recognitionPath": "terminal",
            "engine": result.engine,
            "audioMs": request.audio_ms,
            "decodeMs": result.decode_ms,
            "startedAtMs": round(request.started_at_ms, 2),
            "endedAtMs": round(request.ended_at_ms, 2),
            "droppedPartials": self._dropped_partials,
            "unknownRatio": round(result.unknown_ratio, 4),
            "noSpeechProb": round(result.no_speech_prob, 4),
            "alternatives": [
                {"text": item.text, "confidence": item.confidence}
                for item in result.alternatives
                if item.text
            ],
            "words": [
                {
                    "word": word.word,
                    "startMs": word.start_ms,
                    "endMs": word.end_ms,
                    "probability": word.probability,
                }
                for word in result.words
            ],
            "speaker": self._attribute(request),
            "cadence": self._adapt(
                result.words,
                request.audio_ms,
                semantic_complete=state.semantic_complete,
            ),
            "endpointReason": request.endpoint_reason,
            **self._sample_timing(request),
        }
        if rejected:
            message["reason"] = "no_speech"
        if presence is not None:
            message["speechPresence"] = round(presence, 4)
        await self.send(message)
        self._utterances.pop(request.utterance_id, None)

    async def _send_guard_final(
        self,
        request: DecodeRequest,
        state: _UtteranceState,
        *,
        reason: str,
        speech_presence: float | None = None,
    ) -> None:
        message: dict[str, Any] = {
            "type": "final",
            **self._identity_with_revision(state),
            "text": "",
            "lifecycle": "confirmed",
            "recognitionPath": "terminal",
            "engine": "whisper",
            "audioMs": request.audio_ms,
            "decodeMs": 0,
            "startedAtMs": round(request.started_at_ms, 2),
            "endedAtMs": round(request.ended_at_ms, 2),
            "droppedPartials": self._dropped_partials,
            "words": [],
            "reason": reason,
            "speaker": None,
            "cadence": self._adapt(
                (),
                request.audio_ms,
                semantic_complete=state.semantic_complete,
            ),
            "endpointReason": request.endpoint_reason,
            **self._sample_timing(request),
        }
        if speech_presence is not None:
            message["speechPresence"] = round(speech_presence, 4)
        await self.send(message)
        self._utterances.pop(request.utterance_id, None)

    def _attribute(self, request: DecodeRequest) -> dict[str, object] | None:
        """Speaker attribution runs on the raw utterance, before preprocessing."""
        if self.speaker_gate is None:
            return None
        verdict = self.speaker_gate.verify(request.audio)
        self.telemetry.count(f"speaker_{verdict.decision.value}")
        return verdict.as_message()

    def _adapt(
        self,
        words: Any,
        audio_ms: int,
        *,
        semantic_complete: bool = False,
    ) -> dict[str, object]:
        state = self.cadence.observe(
            words,
            audio_ms,
            semantic_complete=semantic_complete,
        )
        # The semantic value is a one-utterance hangover, not a cadence sample.
        # Keep the learned/adaptive budget for the next ordinary utterance.
        self.segmenter.end_silence_ms = (
            self.cadence.end_silence_ms if semantic_complete else state.end_silence_ms
        )
        self.telemetry.observe("end_silence_ms", state.end_silence_ms)
        self.telemetry.observe("speech_ms", audio_ms)
        return state.as_message()

    def set_expectation(
        self,
        expectation: Expectation,
        context_version: int | None = None,
    ) -> None:
        """Narrow recognition for future utterances without rewriting history."""
        self._expectation = expectation
        if context_version is not None:
            self._context_version = context_version
        if isinstance(self.recognizer, RoutedRecognizer):
            self.recognizer.set_expectation(expectation)

    @property
    def stream_id(self) -> str | None:
        return self._stream_id

    @property
    def context_version(self) -> int | None:
        return self._context_version

    @property
    def original_context_version(self) -> int | None:
        """Context version used by the next speech-start capture."""
        return self._context_version

    async def __aenter__(self) -> AsrSession:
        await self.start()
        return self

    async def __aexit__(self, *_: object) -> None:
        with contextlib.suppress(Exception):
            await self.close()
