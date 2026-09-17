# Full Problem Statement

## Real-Time Clinical Voice Input for Dental Workflows

### Context

Voice-based clinical charting already exists in dentistry, especially for workflows such as periodontal charting and clinical note capture. The basic concept is proven: a dentist speaks measurements or findings, speech recognition converts the audio into text, and the software enters that information into the patient record.

However, a real dental operatory is not a clean speech-recognition environment.

The clinician is rarely speaking isolated commands into a quiet microphone. They may be talking to the patient, speaking to an assistant, thinking aloud, correcting themselves, moving quickly through measurements, using abbreviations, and working while suction, instruments, chairs, and other equipment are producing background noise.

The result is that a system can perform well under ideal conditions while still becoming frustrating or unreliable during the exact situations where hands-free charting is supposed to provide the most value.

The problem is therefore **not simply speech-to-text accuracy**.

The real challenge is:

> **How can a clinical voice system continuously extract the correct structured dental information from natural, noisy, fast-moving speech while maintaining both low latency and high accuracy?**

---

# Core Problems We Aim to Solve

## 1. Latency and Tail Latency

Voice charting must feel immediate.

Even when average transcription latency is acceptable, occasional slow responses can interrupt the clinician's rhythm. A dentist moving rapidly through periodontal measurements cannot comfortably wait for the interface to catch up.

The problem is therefore not only average latency, but also **tail latency**: the slower minority of recognition events that make the system feel inconsistent.

A useful system should minimize the delay between:

> clinician speaks → correct structured value appears in the chart

without sacrificing reliability.

---

## 2. Irrelevant Dentist Speech

Dentists do not speak only charting commands.

During treatment they may say things such as:

- "Okay, this looks fine."
- "Can you pass me that?"
- "We'll take another look at this later."
- "Three, four, five."
- "You might feel some pressure here."

Only part of this speech belongs in the clinical chart.

A voice system must distinguish between:

- **chartable clinical information**
- casual conversation
- procedural discussion
- instructions to assistants
- speech directed at the patient
- filler words and thinking aloud

Otherwise natural speech creates false entries.

The clinician should not be forced to constantly activate and deactivate the system or speak only in rigid command phrases.

---

## 3. Background Operatory Noise

Dental clinics contain significant acoustic interference, including:

- suction
- handpieces and drills
- ultrasonic scalers
- chair movement
- instrument sounds
- nearby conversations
- HVAC and room noise
- patient speech

These sounds can reduce speech recognition quality or create false detections.

The system must continue functioning in an environment that resembles an actual operatory rather than a quiet demonstration room.

---

## 4. Phonetic Ambiguity

Dental charting frequently contains very short words and numbers that are phonetically ambiguous.

Examples include:

- two / to / too
- four / for
- eight / ate
- similar-sounding tooth numbers
- similar-sounding clinical terminology

Traditional transcription may correctly recognize the sound while still assigning the wrong meaning.

In clinical charting, meaning depends heavily on context.

For example:

- if the system is expecting a probing depth, "four" probably represents the number `4`
- if the clinician is selecting a tooth, the same sound may refer to a tooth identifier
- if the clinician is speaking conversationally, the same word may not be clinical data at all

The system therefore needs to interpret speech in relation to the active clinical context.

---

## 5. Rigid Command-Style Speaking

Many voice systems become more reliable when users speak using predefined phrases, explicit commands, fixed pacing, or carefully separated values.

This makes the technology work, but forces clinicians to adapt their behavior to the software.

A useful clinical voice interface should instead tolerate:

- natural sentence structure
- different phrasing
- variable pauses
- different grouping styles
- faster and slower speakers
- natural transitions between measurements and findings

The goal is for the software to adapt to the dentist rather than the dentist adapting to the software.

---

## 6. Corrections and Repetitions

Clinicians regularly correct themselves while speaking.

Examples:

- "four... no, five"
- "tooth fourteen—sorry, fifteen"
- "three three four... repeat that, three four four"
- repeating a value because they are unsure whether the software heard it

A naive transcription system may interpret these as multiple independent values.

The charting system must distinguish between:

- a new measurement
- a repeated measurement
- a correction
- a confirmation
- speech that supersedes something said moments earlier

Corrections should update the intended value rather than produce duplicate or shifted data.

---

## 7. Multiple Speakers and Speaker Attribution

The dentist is not the only person speaking in the operatory.

Speech may come from:

- the dentist
- an assistant
- the patient
- another clinician
- people nearby

The system must determine which speech is intended to control or populate the clinical record.

A patient's statement such as:

> "It hurts around number four."

must not automatically be interpreted the same way as a clinician entering a measurement.

Incorrect speaker attribution can create false clinical entries even when the speech recognition itself is technically correct.

---

## 8. Speaking-Speed and Cadence Sensitivity

Different clinicians speak at very different speeds.

Some may pause between every value:

> "three... four... five..."

Others may rapidly say:

> "three four five, two three three, four four five"

Clinical software should not require the dentist to deliberately slow down to match the recognition system.

The system must tolerate:

- rapid sequences
- uneven pacing
- pauses of different lengths
- grouped measurements
- natural interruptions

while maintaining correct alignment between spoken values and chart fields.

---

## 9. Sequence-Shift Errors in Grouped Measurements

Periodontal and similar charting workflows often involve ordered sequences of values.

For example:

> `3 4 5 | 4 3 2`

If one value is missed, inserted twice, or interpreted incorrectly, the problem can propagate.

Instead of one incorrect measurement, every subsequent measurement may be assigned to the wrong site.

This creates a particularly dangerous class of failure:

> **a small recognition error causes a large structural charting error.**

The system must therefore protect the sequence itself, not merely recognize individual numbers accurately.

---

## 10. Losing Track of Tooth, Site, or Mouth Position

Clinical measurements have meaning only when attached to the correct anatomical location.

The system needs to continuously understand the active context, such as:

- current tooth
- current surface
- current periodontal site
- measurement direction
- whether a tooth was skipped
- whether the clinician moved backward
- whether the clinician jumped to another region

A perfectly recognized value entered into the wrong tooth or site is still clinically incorrect.

Therefore, maintaining **workflow position and anatomical context** is a core part of the voice problem.

---

## 11. Short-Utterance Recognition

Many of the most important dental inputs are extremely short.

Examples:

- "three"
- "four"
- "bleeding"
- "no"
- "one"
- "mobility two"

Short utterances provide very little linguistic context to a general-purpose speech recognizer.

That makes them especially vulnerable to:

- incorrect transcription
- delayed recognition
- confusion with conversational speech
- phonetic ambiguity

Clinical voice systems must perform reliably even when the meaningful input contains only one or two words.

---

## 12. Negation Errors

Small differences in language can completely reverse clinical meaning.

Examples:

- "bleeding" vs "no bleeding"
- "mobility" vs "no mobility"
- "pain" vs "no pain"
- "recession" vs "no recession"

Missing or incorrectly interpreting a single negation can create a chart entry with the opposite meaning from what the clinician intended.

Negation therefore requires stronger handling than ordinary transcription.

---

## 13. Dental Terminology and Abbreviations

Clinical dental speech includes terminology that is uncommon in everyday conversational datasets.

Examples may include:

- probing depth
- recession
- furcation
- suppuration
- mobility grades
- gingival margin
- tooth surfaces
- procedure shorthand
- dental abbreviations
- practice-specific terminology

A general-purpose language model or speech recognizer may misunderstand these terms or substitute more common words.

The system must understand dental vocabulary while still supporting natural speech.

---

## 14. Accent, Dialect, and Individual Speech Variation

No two clinicians speak identically.

Recognition performance may vary with:

- accent
- dialect
- pronunciation
- speaking speed
- pitch
- microphone distance
- personal terminology
- non-native English speech

A clinical system should not work well only for one carefully tested speaker.

It should remain reliable across different users without requiring extensive retraining for every clinician.

---

# Why These Problems Matter Together

These are not independent issues.

In a real operatory they often occur simultaneously.

For example:

> A dentist with a strong regional accent rapidly says a sequence of six probing depths while suction is running, an assistant speaks in the background, and the dentist corrects the fourth value halfway through.

The system must still determine:

1. which speaker matters,
2. which words are clinically relevant,
3. what values were spoken,
4. what each value means,
5. which tooth and site they belong to,
6. whether one value was a correction,
7. whether the sequence has remained aligned,
8. and whether the final result can be entered quickly enough to avoid slowing the clinician.

This is why the problem cannot be reduced to:

> "Improve speech-to-text accuracy."

The actual problem is **real-time contextual clinical speech understanding**.

---

# Proposed Problem Statement

> **Existing dental voice-charting systems demonstrate that speech can be used for hands-free clinical documentation, but real-world clinical environments introduce latency, irrelevant speech, background noise, multiple speakers, phonetic ambiguity, rapid numerical sequences, corrections, short utterances, terminology variation, and continuous anatomical context changes. These failure modes can produce delays, false entries, or values being attached to the wrong clinical location.**
>
> **The challenge is to build a real-time clinical voice intelligence layer capable of extracting only relevant dental information from natural speech, maintaining the correct clinical and anatomical context, handling corrections and ambiguity, and producing structured chart data with both low latency and high accuracy.**

---

# What Makes This Different From Basic Voice Charting

This project is **not**:

- another speech-to-text interface
- a transcription application
- a voice-controlled form
- a system that requires strict commands
- an attempt to train a completely new general-purpose speech model

The focus is the difficult layer between speech recognition and the clinical record:

> **understanding what should actually be charted, what it means in the current dental context, and where it belongs.**

---

# Scope for the Hackathon

The initial implementation should focus on the problems we believe can realistically be demonstrated within the hackathon:

1. latency and tail-latency reduction
2. irrelevant-speech filtering
3. background-noise robustness
4. phonetic/contextual disambiguation
5. natural speech instead of rigid commands
6. spoken correction and repetition handling
7. speaker attribution
8. variable speaking speed and cadence
9. prevention of sequence-shift errors
10. tooth/site/context tracking
11. short-utterance recognition
12. negation handling
13. dental terminology and abbreviations
14. accent and speaker variation

These capabilities should be evaluated as parts of **one continuous clinical workflow**, not as isolated demos.

---

# Success Criteria

A successful prototype should demonstrate that a clinician can:

- speak naturally rather than using a rigid command vocabulary,
- speak at realistic clinical speed,
- work with simulated operatory noise,
- talk conversationally without contaminating the chart,
- have another speaker present without their speech becoming clinical input,
- enter short numerical measurements reliably,
- correct themselves naturally,
- use ambiguous words that are resolved through clinical context,
- move through tooth/site sequences without chart alignment drifting,
- and see structured clinical data appear with minimal perceived latency.

The final objective is simple:

> **The clinician should be able to concentrate on the patient while the voice system maintains the structure, context, accuracy, and speed required by the clinical record.**
