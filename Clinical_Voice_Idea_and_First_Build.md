# Clinical Voice Intelligence Layer

## Idea Summary

We are building a **real-time clinical voice intelligence layer for dental charting**.

Voice-based dental charting already exists, but real clinics are difficult environments:

- dentists speak naturally instead of using perfect commands
- they talk to patients and assistants while charting
- background noise interferes
- short words and numbers are phonetically ambiguous
- clinicians correct themselves mid-sentence
- rapid grouped measurements can shift into the wrong chart fields
- the system must always know the current tooth, surface, and measurement type
- low latency is essential

The project is **not another speech-to-text application**.

The core problem is:

> How do we convert natural, noisy, fast-moving clinical speech into the correct structured dental data with very low latency and high accuracy?

The system sits between a streaming speech recognizer and the dental chart.

---

# Core Product Concept

The system continuously understands:

- who is speaking
- whether the speech is clinically relevant
- what clinical workflow is currently active
- which tooth is active
- which surface/site is active
- what kind of value is expected
- whether the clinician is entering a new value, repeating one, or correcting one
- whether an ambiguous word makes sense in the current clinical context

Instead of storing raw transcript, it converts speech into structured clinical events.

Example:

Dentist says:

> "three four five, bleeding... four—no, three"

The system should produce:

```text
Tooth 14 – Buccal

MB: 3
B:  4
DB: 3
Bleeding: Yes
```

The correction should replace the intended value rather than create an extra measurement.

---

# What Makes This Different

Existing systems already perform voice charting.

Our differentiation is not:

> "We can recognize dental speech."

It is:

> "We make clinical voice input reliable under real-world conditions."

The main issues we are targeting are:

1. latency and tail latency
2. irrelevant dentist speech
3. background operatory noise
4. phonetic ambiguity
5. rigid command-style speaking
6. corrections and repetitions
7. multiple speakers / speaker attribution
8. speaking-speed and cadence variation
9. sequence-shift errors
10. loss of tooth/site context
11. short-utterance recognition
12. negation errors
13. dental terminology and abbreviations
14. accent and speaker variation

The final goal is:

> The dentist should speak naturally while the software maintains the context, structure, accuracy, and speed required by the dental chart.

---

# What We Build First

Do **not** start with every problem at once.

The first milestone is the smallest end-to-end system that proves the core idea.

## Phase 1 — Core Structured Capture

Build:

```text
Microphone
   ↓
Streaming ASR
   ↓
Clinical Context State
   ↓
Structured Perio Parser
   ↓
Live Perio Chart
```

The first version only needs to support a single periodontal charting workflow.

---

## First Demo Scenario

The system has this active state:

```text
Current tooth: 14
Current surface: Buccal
Expected values: 3 probing depths
```

Dentist says:

> "three four five"

The chart immediately becomes:

```text
MB: 3
B:  4
DB: 5
```

Then:

> "bleeding"

The system adds:

```text
Bleeding: Yes
```

Then:

> "four... no, three"

The intended value is corrected rather than creating another measurement.

---

# First Four Capabilities

## 1. Streaming Speech Input

Capture microphone audio through a streaming speech recognizer.

We need access to:

- partial transcription
- final transcription
- timestamps / latency measurements

The important metric is:

> time from spoken value → correct structured value appearing in the chart

---

## 2. Clinical Context State

Create a small state object that tracks:

```text
current_tooth
current_surface
current_measurement_type
expected_value_count
current_position_in_sequence
```

Example:

```json
{
  "tooth": 14,
  "surface": "buccal",
  "measurement": "probing_depth",
  "expected_values": 3,
  "position": 0
}
```

This context will later become the foundation for ambiguity resolution, sequence protection, and natural speech handling.

---

## 3. Speech → Structured Clinical Data

The system must not merely show a transcript.

It must convert speech into structured events.

Examples:

```text
"three four five"
→ probing_depths = [3, 4, 5]

"bleeding"
→ bleeding = true

"no bleeding"
→ bleeding = false
```

The output should update a simple live periodontal chart.

---

## 4. Correction Handling

The system must support natural corrections from the beginning.

Examples:

```text
"four... no, three"
→ replace 4 with 3
```

```text
"tooth fourteen... sorry, fifteen"
→ active tooth becomes 15
```

```text
"three three four... repeat that, three four four"
→ replace the previous sequence
```

This is one of the first places where the system becomes more than ordinary transcription.

---

# Why This Comes First

If we cannot reliably turn speech into structured data while maintaining clinical state, every later feature becomes meaningless.

This first milestone proves:

- the system understands clinical context
- speech updates structured chart fields
- corrections do not corrupt the sequence
- latency can be measured
- we have an end-to-end workflow to improve

Once this works, we can progressively make the environment more difficult.

---

# Build Order After the First Milestone

After the core structured capture works, add features in this order:

1. **Irrelevant-speech filtering**
   - Ignore casual speech and non-chartable conversation.

2. **Sequence protection**
   - Prevent one missed/repeated number from shifting all following sites.

3. **Context-aware phonetic disambiguation**
   - Resolve `two/to/too`, `four/for`, etc. based on the active workflow.

4. **Negation handling**
   - Correctly distinguish `bleeding` from `no bleeding`.

5. **Natural corrections and repetitions**
   - Expand beyond the simple initial correction cases.

6. **Background-noise robustness**
   - Test with suction, instruments, chatter, and recorded operatory noise.

7. **Multiple-speaker handling**
   - Distinguish clinician speech from patient/assistant speech.

8. **Speaking-speed and cadence robustness**
   - Support fast grouped measurements and inconsistent pauses.

9. **Context / position recovery**
   - Handle skipped teeth, changing surfaces, jumping backward, and workflow interruptions.

10. **Dental terminology and accent robustness**
    - Expand clinical vocabulary and test across different speakers.

---

# Initial Success Criteria

The first working prototype is successful if it can:

- listen continuously
- receive streaming speech
- understand a known periodontal charting context
- convert numbers into the correct structured chart fields
- recognize a bleeding flag
- handle a spoken correction
- avoid shifting later values because of that correction
- display the result immediately
- measure end-to-end latency

The first version does **not** need to solve every noise, accent, or multi-speaker problem.

It only needs to prove that:

> **clinical context + streaming speech can produce fast, structured, correction-aware dental charting.**

That becomes the foundation for every other problem we plan to solve.
