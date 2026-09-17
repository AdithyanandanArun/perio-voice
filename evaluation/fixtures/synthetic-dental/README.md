# Synthetic dental speech fixture

Thirty charting utterances rendered with Piper TTS (`en_US-lessac-medium`),
covering grouped depths, single digits, findings, context changes, spoken
corrections, workflow commands, and two conversational phrases that must never
chart.

## What this is for

The project's other speech fixture is eleven seconds of a political speech. It
is long-form, continuous, and contains no clinical vocabulary, which is why this
project once reported word error rate 0.000 while real charting worked about a
quarter of the time. This fixture exists so recognizers can be compared on the
words the product actually has to hear, at the durations it actually hears them
(mean 0.91 s).

## What it is not

**Synthesized speech, one voice, no room.** Absolute accuracy measured here is
optimistic for every engine: there is no microphone, no reverberation, no
operatory noise, and none of the variation a real clinician brings. Use it to
compare engines against each other, never to claim a recognition rate.

A recorded fixture from real clinicians is the measurement that settles
accuracy. `evaluation/fixtures/dental/` and `npm run dev` with
`PERIO_FIXTURE_CAPTURE=1` exist to collect one; this stands in until it does.

## Regenerating

```bash
uv run --with piper-tts --with soundfile python scripts/generate_synthetic_dental.py
```

Piper is deliberately not a project dependency. The rendered audio is committed
so every gate runs without it.
