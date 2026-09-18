"""Deterministic positive/negative controls for the streaming fast endpoint.

This oracle deliberately uses tiny in-memory recognizer doubles.  It proves the
ordering and *attribution* contract, not just that some short hangover message
happened to arrive in the assertion window:

* the semantic hint actually latches -- the endpoint fires before ``stop()`` is
  called, is tagged ``endpointReason: "semantic"``, and its
  ``(endSample - lastVoiceSample) / 16`` hangover lands in [120, 200] ms;
* when the grammar returns text but never completes (no words, no
  ``semantic_complete``), the fast path must NOT fire: no semantic endpoint
  arrives before ``stop()``, and the eventual stop-flushed endpoint/final are
  tagged ``"stop"``, never ``"semantic"``. Earlier versions of this oracle
  passed on this input anyway, because stop()'s own 160 ms tail happened to sit
  inside the asserted window -- the oracle proved nothing about the feature it
  was named for;
* a *stable, structurally complete* partial latches the semantic endpoint even
  when Vosk's own completion signal (``semantic_complete``/``words``) never
  fires at all -- this is the control for F9/F10's actual fix: the hint must
  not depend on Vosk's ~500 ms endpointer to notice a clinically whole phrase;
* a lone, never-complete value ("three") followed by a pause must not end the
  utterance semantically, even though the same double returns text on every
  feed -- one value is never a whole station, no matter how long it repeats;
* the terminal result still comes from the Whisper recognizer;
* identity, lifecycle, revision and sample timing stay ordered; and
* an ordered audio gap invalidates the active utterance and closes its grammar
  session instead of bridging the missing samples.
"""

from __future__ import annotations

import asyncio
import sys
from array import array
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.config import Settings  # noqa: E402
from server.recognizer import ModelStatus, RecognitionResult, WordTiming  # noqa: E402
from server.routed_recognizer import RoutedRecognizer  # noqa: E402
from server.routing import Engine  # noqa: E402
from server.session import AsrSession  # noqa: E402


def pcm(level: int, milliseconds: int) -> bytes:
    """Return deterministic mono PCM16 at the protocol sample rate."""
    return array("h", [level] * (16 * milliseconds)).tobytes()


class HintSession:
    """A grammar session double.

    ``completes`` controls the defect this oracle must be able to catch: when
    False, the session returns text but never reports completion, exactly
    like a grammar recognizer whose semantic-complete hint never latches.
    """

    def __init__(self, text: str, *, completes: bool) -> None:
        self.text = text
        self.completes = completes
        self.calls = 0
        self.closed = False
        self.semantic_complete = False

    async def feed_pcm(self, _payload: bytes) -> RecognitionResult:
        self.calls += 1
        if self.completes:
            self.semantic_complete = True
            return RecognitionResult(
                text=self.text,
                decode_ms=1,
                engine="grammar",
                words=(WordTiming("three", 0, 100, 0.9),),
            )
        # Text without words and without semantic_complete: exactly the
        # "grammar disabled/never completes" case F2's negative control must
        # prove does not shorten the hangover.
        return RecognitionResult(text=self.text, decode_ms=1, engine="grammar")

    def close(self) -> None:
        self.closed = True


class HintRecognizer:
    model_name = "vosk-test"
    device = "cpu"
    compute_type = "grammar"
    status = ModelStatus.READY
    error: str | None = None

    def __init__(self, text: str, *, completes: bool = True) -> None:
        self.text = text
        self.completes = completes
        self.sessions: list[HintSession] = []

    async def load(self) -> None:
        self.status = ModelStatus.READY

    def set_expectation(self, _expectation: object) -> None:
        return

    async def open_session(self, _expectation: object = None) -> HintSession:
        session = HintSession(self.text, completes=self.completes)
        self.sessions.append(session)
        return session


class StableTextSession:
    """A grammar session double that never signals completion via Vosk itself.

    ``feed_pcm`` returns the same text on every call, with no ``words`` and
    no ``semantic_complete`` -- exactly what a real Vosk session looks like
    before it has accumulated 500 ms of trailing silence. This exercises the
    structural-completeness path (server.vocabulary.is_structurally_complete
    plus session.py's stability latch) in isolation from Vosk's own signal,
    which is the actual fix for F9: the hint no longer needs Vosk's opinion.
    """

    def __init__(self, text: str) -> None:
        self.text = text
        self.calls = 0
        self.closed = False
        self.semantic_complete = False

    async def feed_pcm(self, _payload: bytes) -> RecognitionResult:
        self.calls += 1
        return RecognitionResult(text=self.text, decode_ms=1, engine="grammar")

    def close(self) -> None:
        self.closed = True


class StableTextRecognizer:
    model_name = "vosk-test"
    device = "cpu"
    compute_type = "grammar"
    status = ModelStatus.READY
    error: str | None = None

    def __init__(self, text: str) -> None:
        self.text = text
        self.sessions: list[StableTextSession] = []

    async def load(self) -> None:
        self.status = ModelStatus.READY

    def set_expectation(self, _expectation: object) -> None:
        return

    async def open_session(self, _expectation: object = None) -> StableTextSession:
        session = StableTextSession(self.text)
        self.sessions.append(session)
        return session


class TerminalWhisper:
    model_name = "large-v3"
    device = "cuda"
    compute_type = "int8_float16"
    status = ModelStatus.READY
    error: str | None = None

    def __init__(self) -> None:
        self.calls: list[bool] = []

    async def load(self) -> None:
        self.status = ModelStatus.READY

    async def transcribe(
        self,
        _audio: Any,
        *,
        partial: bool,
        beam_size: int | None = None,
    ) -> RecognitionResult:
        del beam_size
        self.calls.append(partial)
        return RecognitionResult(
            text="TERMINAL_WHISPER" if not partial else "WHISPER_PARTIAL",
            decode_ms=7,
            engine="whisper",
        )


def make_stack(
    *, grammar_completes: bool = True
) -> tuple[Settings, RoutedRecognizer, TerminalWhisper, HintRecognizer]:
    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=40,
        end_silence_ms=520,
        partial_interval_ms=40,
        # AUTO mirrors the shipped GPU deployment's mixed hint/terminal setup;
        # the terminal route must still be Whisper on CUDA.
        engine=Engine.AUTO,
        model_name="large-v3",
        device="cuda",
        compute_type="int8_float16",
        speech_presence_threshold=0.0,
    )
    terminal = TerminalWhisper()
    grammar = HintRecognizer("GRAMMAR_PROVISIONAL", completes=grammar_completes)
    routed = RoutedRecognizer(settings, whisper=terminal, grammar=cast(Any, grammar))
    return settings, routed, terminal, grammar


def make_stack_with_grammar(
    grammar: StableTextRecognizer,
) -> tuple[Settings, RoutedRecognizer, TerminalWhisper]:
    settings = Settings(
        vad_rms_threshold=0.01,
        pre_roll_ms=0,
        min_speech_ms=40,
        end_silence_ms=520,
        partial_interval_ms=40,
        engine=Engine.AUTO,
        model_name="large-v3",
        device="cuda",
        compute_type="int8_float16",
        speech_presence_threshold=0.0,
    )
    terminal = TerminalWhisper()
    routed = RoutedRecognizer(settings, whisper=terminal, grammar=cast(Any, grammar))
    return settings, routed, terminal


async def positive_control() -> None:
    """The grammar hint latches: a short, attributable semantic endpoint."""
    settings, recognizer, terminal, grammar = make_stack(grammar_completes=True)
    messages: list[dict[str, Any]] = []
    stop_called_at_message_count: int | None = None

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    session = AsrSession(
        recognizer,
        settings,
        send,
        stream_id="fast-control",
        original_context_version=9,
    )
    await session.start()
    for index in range(3):
        await session.feed(pcm(10_000, 40), (index + 1) * 40)
    # The grammar result latches the short hangover. Four 40 ms silence frames
    # therefore endpoint at 160 ms rather than the ordinary 520 ms budget.
    for index in range(4):
        await session.feed(pcm(0, 40), 160 + index * 40)

    # The endpoint for this utterance must already have arrived from the
    # natural (silence-threshold) finish inside feed() -- BEFORE stop() is
    # ever called. That ordering is the attribution proof: a stop-flush could
    # never have produced this endpoint, because stop() has not run yet.
    endpoint_before_stop = [message for message in messages if message["type"] == "endpoint"]
    if not endpoint_before_stop:
        raise AssertionError("no endpoint arrived before stop() was called")
    if endpoint_before_stop[0]["endpointReason"] != "semantic":
        raise AssertionError(
            f"endpoint before stop() was {endpoint_before_stop[0]['endpointReason']!r}, "
            "not 'semantic'"
        )
    stop_called_at_message_count = len(messages)

    await session.stop(360)
    await session.close()

    types = [message["type"] for message in messages]
    assert "speech_start" in types and "partial" in types
    endpoint_index = types.index("endpoint")
    final_index = types.index("final")
    assert endpoint_index < final_index
    assert endpoint_index < stop_called_at_message_count, (
        "the endpoint must be emitted before stop() runs, not by stop()'s own flush"
    )
    fast_partial = next(message for message in messages if message["type"] == "partial")
    endpoint = messages[endpoint_index]
    final = messages[final_index]
    assert fast_partial["recognitionPath"] == "fast"
    assert fast_partial["lifecycle"] == "provisional"
    assert final["text"] == "TERMINAL_WHISPER"
    assert final["recognitionPath"] == "terminal"
    assert final["lifecycle"] == "confirmed"
    assert terminal.calls == [False]
    assert grammar.sessions and all(item.closed for item in grammar.sessions)

    # The attribution itself: both the endpoint and the final for this
    # utterance must name the semantic hint as the reason it ended, and the
    # measured hangover -- computed directly from absolute sample offsets --
    # must fall inside the declared 120-200 ms band.
    assert endpoint["endpointReason"] == "semantic"
    assert final["endpointReason"] == "semantic"
    for message in (endpoint, final):
        assert message["startSample"] <= message["lastVoiceSample"] <= message["endSample"]
    hangover_ms = (final["endSample"] - final["lastVoiceSample"]) / 16
    assert 120 <= hangover_ms <= 200, f"semantic hangover {hangover_ms} ms outside [120, 200]"

    utterance_messages = [
        message
        for message in messages
        if message["type"] in {"speech_start", "partial", "endpoint", "final"}
    ]
    revisions = [int(message["revision"]) for message in utterance_messages]
    assert revisions == sorted(revisions) and len(set(revisions)) == len(revisions)
    assert all(message["streamId"] == "fast-control" for message in utterance_messages)
    assert all(message["transactionId"] == "fast-control:1" for message in utterance_messages)
    assert all(message["originalContextVersion"] == 9 for message in utterance_messages)
    assert all(message["sampleRate"] == 16_000 for message in utterance_messages)
    assert final["endSample"] - final["startSample"] == final["durationSamples"]


async def negative_incomplete_grammar_control() -> None:
    """Grammar returns text but never completes: the fast path must not fire.

    Identical setup to ``positive_control`` except the grammar session never
    reports a word or ``semantic_complete``. Without the semantic hint, the
    4x40 ms of trailing silence (160 ms) is well short of the ordinary 520 ms
    hangover, so the utterance must still be open when stop() is called --
    and the resulting endpoint/final must be attributed "stop", never
    "semantic". This is the control the old marker-string oracle could not
    fail: its assertions happened to hold even when the feature was inert,
    because stop()'s own flush produced a similarly-short tail.
    """
    settings, recognizer, terminal, grammar = make_stack(grammar_completes=False)
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    session = AsrSession(recognizer, settings, send, stream_id="incomplete-control")
    await session.start()
    for index in range(3):
        await session.feed(pcm(10_000, 40), (index + 1) * 40)
    for index in range(4):
        await session.feed(pcm(0, 40), 160 + index * 40)

    # With no semantic hint, 160 ms of trailing silence must not have ended
    # the utterance: the ordinary 520 ms budget is still running.
    if any(message["type"] == "endpoint" for message in messages):
        raise AssertionError("a semantic endpoint fired even though grammar never completed")

    await session.stop(360)
    await session.close()

    endpoint = next(message for message in messages if message["type"] == "endpoint")
    final = next(message for message in messages if message["type"] == "final")
    assert endpoint["endpointReason"] != "semantic", (
        "grammar text without completion must never be attributed 'semantic'"
    )
    assert endpoint["endpointReason"] == "stop"
    assert final["endpointReason"] == "stop"
    assert final["text"] == "TERMINAL_WHISPER"
    assert terminal.calls == [False]
    del grammar


async def structural_stability_control() -> None:
    """A stable, structurally complete partial latches the endpoint alone.

    ``StableTextSession`` never reports ``semantic_complete`` and never
    returns ``words`` -- the two signals Vosk's own endpointer would use.
    The only thing that can latch the hint here is the structural check
    seeing "three four five" (a complete three-site depths station) repeat
    on a second consecutive grammar feed. This is the actual F9 fix: the
    fast path no longer needs Vosk's ~500 ms opinion of completeness.
    """
    settings, recognizer, _terminal = make_stack_with_grammar(
        StableTextRecognizer("three four five")
    )
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    session = AsrSession(recognizer, settings, send, stream_id="structural-control")
    await session.start()
    for index in range(3):
        await session.feed(pcm(10_000, 40), (index + 1) * 40)
    for index in range(4):
        await session.feed(pcm(0, 40), 160 + index * 40)

    endpoint_before_stop = [message for message in messages if message["type"] == "endpoint"]
    if not endpoint_before_stop:
        raise AssertionError(
            "a stable, structurally complete partial did not latch a semantic "
            "endpoint before stop()"
        )
    if endpoint_before_stop[0]["endpointReason"] != "semantic":
        raise AssertionError(
            f"endpoint before stop() was {endpoint_before_stop[0]['endpointReason']!r}, "
            "not 'semantic'"
        )

    await session.stop(360)
    await session.close()

    final = next(message for message in messages if message["type"] == "final")
    assert final["endpointReason"] == "semantic"
    assert final["text"] == "TERMINAL_WHISPER"
    hangover_ms = (final["endSample"] - final["lastVoiceSample"]) / 16
    assert 120 <= hangover_ms <= 200, f"semantic hangover {hangover_ms} ms outside [120, 200]"


async def negative_lone_value_control() -> None:
    """A lone, never-complete value must not latch semantic completion.

    Same repeating-text double as ``structural_stability_control``, but the
    text is a single depth value ("three"). No count of repeats can make one
    value a whole three-site station, so a 200 ms pause after it must still
    be attributed to the ordinary stop -- not to a semantic hint that was
    never structurally entitled to fire.
    """
    settings, recognizer, terminal = make_stack_with_grammar(StableTextRecognizer("three"))
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    session = AsrSession(recognizer, settings, send, stream_id="lone-value-control")
    await session.start()
    await session.feed(pcm(10_000, 40), 40)
    # A 200 ms pause: long enough to exercise the repeat-latch stability
    # check, nowhere near the 520 ms ordinary hangover it must still respect.
    for index in range(5):
        await session.feed(pcm(0, 40), 40 + (index + 1) * 40)

    if any(message["type"] == "endpoint" for message in messages):
        raise AssertionError("a lone, never-complete value latched a semantic endpoint")

    await session.stop(600)
    await session.close()

    endpoint = next(message for message in messages if message["type"] == "endpoint")
    final = next(message for message in messages if message["type"] == "final")
    assert endpoint["endpointReason"] == "stop"
    assert final["endpointReason"] == "stop"
    del terminal


async def negative_gap_control() -> None:
    settings, recognizer, terminal, grammar = make_stack()
    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    session = AsrSession(recognizer, settings, send, stream_id="gap-control")
    await session.start()
    await session.feed(pcm(10_000, 120), 120)
    try:
        await session.handle_audio_gap(
            stream_id="gap-control",
            sample_rate=8_000,
            start_sample=1_920,
            end_sample=2_560,
        )
    except ValueError:
        pass
    else:
        raise AssertionError("an invalid sample rate was accepted")

    acknowledgement = await session.handle_audio_gap(
        stream_id="gap-control",
        sample_rate=16_000,
        start_sample=1_920,
        end_sample=3_840,
    )
    assert acknowledgement["type"] == "audio_gap_ack"
    assert all(message["type"] != "final" for message in messages)
    assert grammar.sessions and grammar.sessions[0].closed

    # PCM after the gap starts a fresh utterance; it cannot inherit the first
    # utterance's transaction or a grammar result from before the missing range.
    await session.feed(pcm(10_000, 280), 400)
    await session.stop(1_000)
    await session.close()
    starts = [message for message in messages if message["type"] == "speech_start"]
    assert len(starts) == 2
    assert starts[0]["utteranceId"] != starts[1]["utteranceId"]
    assert starts[0]["transactionId"] != starts[1]["transactionId"]
    assert terminal.calls and all(partial is False for partial in terminal.calls)
    snapshot = session.telemetry.snapshot()
    assert snapshot["counters"]["audio_gaps"] == 1  # type: ignore[index]


async def main() -> None:
    await positive_control()
    await negative_incomplete_grammar_control()
    await structural_stability_control()
    await negative_lone_value_control()
    await negative_gap_control()
    print("FAST_ENDPOINT_ATTRIBUTED_GATE_PASSED")


if __name__ == "__main__":
    asyncio.run(main())
