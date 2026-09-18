# CareStack Voice Perio: latency and workflow gap analysis

Status: public-source review, retrieved 18 September 2026

This is a product and evaluation comparison, not a claim about CareStack's
proprietary implementation. It uses current public CareStack marketing and
support material first. Where those sources do not specify a behaviour, the
text says so explicitly. A common voice-charting risk is an engineering
inference; it is not evidence that CareStack has a defect.
This review does not establish CareStack latency, accuracy, offline support or
any proprietary implementation detail.

## Executive reading

CareStack publicly documents Voice Perio as a hands-free workflow that records
periodontal findings by voice and updates the CareStack perio chart in real
time. Its support article documents a click-to-start/pause/resume/stop flow,
navigation and finding commands, and a useful safety-relevant default: when a
furcation or plaque grade is omitted, Voice Perio defaults to Grade 1.

CareStack also documents ordinary perio-chart constraints outside the voice
marketing page: auto-advance is configurable, practice and provider settings
control the fields and probing direction, completed exams have an edit window,
and manual 10+ or negative gingival-margin entry uses an ALT/Option keyboard
modifier. Those are workflow facts, not claims that CareStack is slow or
unsafe.

Our decision is to make the local layer conservative at the recognition-to-chart
boundary. A missing grade is held rather than invented; grouped values are
accepted or rejected atomically; stale context, dropped audio and ambiguous
speech fail closed; endpoint and final timing are measured from additive sample
evidence; and every in-memory decision carries a trace and journal entry. The
prototype has no CareStack integration, persistence, authentication, or human
operatory corpus, so those remain explicit handoffs.

## Sources and evidence classification

| Source | What it establishes | Classification |
| --- | --- | --- |
| [CareStack Voice Perio product page](https://carestack.com/en-GB/dental-software/features/voice-perio) | Hands-free voice capture; probing depths, bleeding, mobility and other findings; real-time chart/record updates; the page also describes CareStack as cloud dental software; Voice Perio FAQ | Official product documentation |
| [Voice Perio: Perio Charting with Voice Commands](https://carestack.zendesk.com/hc/en-us/articles/47790792843924-Voice-Perio-Perio-Charting-with-Voice-Commands) | The public Zendesk Help Center API (`.../articles/47790792843924.json`, retrieved 18 September 2026) reports `edited_at` 4 June 2026 and `updated_at` 13 August 2026 — the article's content was last edited June 4, and the Zendesk record (which also reflects metadata such as labels or position) was last touched August 13; the two dates measure different things. Start/Pause/Resume/Stop workflow; navigation forms; bleeding/suppuration, plaque/furcation and tooth-status commands; omitted plaque/furcation grade defaults to Grade 1; finding focus returns to where the user left off | Official support documentation |
| [Explore Perio Charting](https://carestack.zendesk.com/hc/en-us/articles/30313408675604-Explore-Perio-Charting) | The same API (`.../articles/30313408675604.json`, retrieved 18 September 2026) reports `edited_at` 7 August 2026 and `updated_at` 13 August 2026 at 07:12:11 UTC — the identical `updated_at` timestamp on both articles suggests a bulk Help Center republish or reindex rather than a coincidence, but this document does not verify that mechanism and does not claim either article's content changed on that date. 24-hour edit note; auto-advance; manual ALT/Option path for 10+ and negative gingival margin; chart cannot be deleted according to the article; conditions are selected on a tooth | Official support documentation |
| [Configure Perio Charting and Manage Permissions](https://carestack-aus.zendesk.com/hc/en-au/articles/25869211238034-Configure-Perio-Charting-and-Manage-Permissions) | Updated December 11, 2025. Practice/provider configuration, selected measurements, auto-advance parameters, permissions, and an edit/delete permission surface | Official support documentation; configuration context can vary |
| [CareStack periodontal charting](https://carestack.com/dental-software/features/periodontal-charting) | Auto-advance, probing-direction templates, warning displays and a Florida Probe integration are advertised | Official product documentation |
| [CareStack integrations](https://carestack.com/dental-software/integrations) | CareStack publicly names Florida Probe (VoiceWorks) as an integration | Official product documentation |

The product page uses “real time” and “instantly,” but none of the reviewed
CareStack sources publishes a p50/p95 endpoint-to-final number, a semantic
hangover limit, a packet-loss policy, or an offline guarantee. We therefore do
not present this document as a benchmark of CareStack latency.

## Gap map

Each row separates the public CareStack fact from the general risk we infer and
the decision we actually made. “Implemented evidence” points to code or tests;
“handoff” is deliberately not represented as a solved capability.

| Area | Documented CareStack capability or constraint | Common voice-charting risk / inference (not a CareStack defect claim) | Perio Voice decision and mapping | Status |
| --- | --- | --- | --- | --- |
| Manual correction and edit limits | The support guide says a completed exam can be changed only within 24 hours and lists editing values/conditions. It also says a Perio Chart cannot be deleted. The configuration guide separately lists a `Delete Perio Chart` permission, so tenant policy/configuration needs confirmation. | A wrong early value may be noticed after focus has moved; a correction path that appends instead of replacing can leave a duplicate or silently alter the wrong site. A short edit window can also make late correction operationally important. | Corrections resolve against the append-only journal, replace the intended value, preserve the superseded entry, and support undo/redo. Delayed or context-changing corrections are held or confirmed. See `src/domain/correction.ts`, `src/domain/journal.ts`, `tests/corrections.test.ts`, `tests/transactionSafety.test.ts`. Durable retention and CareStack edit/delete semantics are not integrated. | Implemented locally; persistence/EHR handoff |
| Auto-advance and positional drift | CareStack documents auto-advance, configurable parameters, and selectable probing direction at practice/provider level. | If a value is dropped, duplicated, or a final arrives after focus moves, automatic cursor movement can make later numbers land on the wrong station. This is a general positional risk, not evidence that CareStack drifts. | The local workflow advances lazily, carries a context version, and refuses stale finals. `sequenceGuard` rejects an inserted/dropped/overflowing group as a unit. See `src/domain/workflow.ts`, `src/domain/sequenceGuard.ts`, `tests/sequenceGuard.test.ts`, `tests/workflowState.test.ts`, `tests/activeWorkflow.test.tsx`. | Implemented and replay-tested |
| Cloud/network dependence | CareStack describes its PMS as cloud software and advertises real-time chart updates. The reviewed Voice Perio/support pages do not state an offline mode, network retry policy, audio retention policy, or a numeric service-level latency. | A cloud voice path can be affected by network availability and round trips; an operator needs a clear recovery state rather than assuming a delayed update was committed. This is a deployment inference, not a CareStack failure finding. | The prototype keeps inference and chart decisions local, exposes `offline`/`processing` states, reconnects with a cap, and never replays buffered clinical audio into a changed context. See `src/speech/useLocalAsr.ts`, `server/app.py`, `ARCHITECTURE.md` failure/recovery section, and `tests/speechAdapter.test.tsx`. We make no claim that CareStack is offline-capable or that its network behaviour is known. | Local-first implementation; CareStack network behavior is a handoff/non-claim |
| Noise and background speech | No reviewed CareStack public Voice Perio source specifies operatory-noise performance, competing-speaker handling, VAD, or false-entry rates. | A prompted or open-vocabulary recognizer can turn suction, handpieces, patient speech, or an assistant request into a plausible clinical token. The risk is common to voice charting; it is not a reported CareStack defect. | Speech presence, saturation and no-speech checks run before charting. Synthetic operatory bursts are replayed with `scripts/verify_noise_rejection.py`; deterministic checks live in `server/speech_presence.py` and `tests/server/test_speech_presence.py`. The noise set is synthetic and one synthetic voice, so a consented human operatory corpus remains required. | Implemented guard; real-clinic validation handoff |
| Rigid command vocabulary and omitted grades | The support article gives structured navigation and finding examples. It says furcation/plaque should specify a grade, but if omitted Voice Perio defaults to Grade 1. Bleeding and suppuration can be spoken at any time and focus returns to the prior location. | A rigid command surface can be hard to use if a modifier is omitted or a phrase is not in the supported vocabulary; broad “natural language” expectations can also hide unparsed words. The default Grade 1 behaviour is documented CareStack behavior, not a claim that it is wrong in every workflow. | The local grammar accepts a bounded, versioned vocabulary and shows unparsed speech. Positive mobility/furcation without an explicit grade is held and cannot be approved by inventing one. See `src/domain/grammar.ts`, `src/domain/negation.ts`, `src/domain/sequenceGuard.ts`, `src/domain/pipeline.ts`, `tests/negation.test.ts`, and `tests/transactionSafety.test.ts`. | Implemented with an intentionally stricter safety choice |
| Double-digit and negative entry friction | The support guide says 10+ measurements require holding ALT/Option while typing the full number; it gives the same modifier path for a negative gingival margin. The guide also documents manual fields and chart settings. | Keyboard modifiers are awkward during a gloved, hands-busy exam. Speech recognition can also split “ten”/“one zero” or lose the negative cue; accepting a partial value would be worse than asking for a repeat. | Spoken numerals and bounded 0–12 recession values are handled by the lattice, context windows and range guards; tests cover compound/numeral and recession resolution (`src/domain/lattice.ts`, `src/domain/contextResolver.ts`, `tests/disambiguation.test.ts`). Negative gingival-margin voice entry is not implemented and is not claimed; a product decision is needed before adding it. | Positive/double-digit path implemented; negative-margin parity is an explicit handoff |
| Auditability and record history | CareStack public pages describe findings stored in the patient chart and document edit/delete permissions, but the Voice Perio article does not document per-command provenance, transcript retention, or an event-level audit API. | Real-time automatic writes need an operator-visible answer to “what was heard, what changed, and what can be undone?” Hidden transcript retention would also create privacy and governance obligations. | Each local decision has a stage trace; durable changes use an append-only in-memory journal with supersession/compensation metadata. `src/domain/journal.ts`, `src/domain/pipeline.ts`, `src/components/HistoryPanel.tsx`, and `tests/transactionSafety.test.ts` cover the current boundary. Persistent audit export, role-based access, retention and EHR write-back are not built. | Explainable in memory; regulated audit/persistence handoff |
| Recovery and user feedback | CareStack documents Pause/Resume/Stop and says bleeding/suppuration commands return focus to the previous location. Its pages do not publish recovery timing, retry semantics, or how an ambiguous voice result is presented. | A user needs to know whether listening is active, whether a result is provisional, and whether a correction or network loss left the chart unchanged. | Partials never commit; endpoint/final identities and lifecycle fields are additive; held/ignored/rejected outcomes are visible with a trace; the simulator remains available when ASR is offline. See `src/speech/useLocalAsr.ts`, `src/domain/session.ts`, `src/components/CapturePanel.tsx`, `src/components/HistoryPanel.tsx`, `tests/speechAdapter.test.tsx`, and `tests/accessibility.test.tsx`. No usability or CareStack UI comparison is claimed. | Implemented local recovery/feedback; usability study handoff |
| Configuration and tenant variation | CareStack documents practice-level fields, alert points, probing direction, auto-advance parameters, provider overrides, permissions, and selectable graph/display options. A separate page exposes nine probing templates. | A command or sequence that is safe under one office's fields/direction can be wrong under another's; configuration must be visible in the evaluation and not silently assumed. | The local runtime reports model/device, sample rate, endpoint band, cadence mode and prompt version from `/api/health`; `ASR_*` settings are explicit and replay reports record the configuration. Clinical context and expected measurement are carried into parsing. See `server/config.py`, `server/app.py`, `README.md`, and `tests/server/test_config.py`. CareStack tenant configuration is not imported or synchronized. | Implemented local configuration; integration/config sync handoff |
| Latency evidence | CareStack markets real-time/instant updates but publishes no endpoint-to-final or last-voice-to-chart measurements in the reviewed sources. | “Real time” can conceal capture, endpoint, queue, decode and UI commit tails; a fast median can still leave a clinician waiting on a p95 tail. | `scripts/verify_live_recognizer.py` streams the real socket and records endpoint sample timing, last-voiced-sample → endpoint hangover, endpoint → final arrival, last-voiced-sample → final, chart exact match, false entries, split finals, and model/device. `scripts/verify_latency_quality.py` independently recomputes thresholds. No CareStack latency number is inferred. | Implemented measurement; apples-to-apples competitor benchmark is a handoff |

## Accepted limits and non-claims

The product mappings below are explicit non-claims where a capability is not
implemented; those rows are handoffs rather than implied parity.

The following statements are intentionally narrow:

- CareStack's public pages establish a voice workflow and configuration choices;
  they do not establish proprietary model internals, recognition accuracy,
  background-noise performance, cloud retry behavior, offline support, or an
  event-level audit API.
- “Common voice-charting risk” means a design risk we test locally. It does not
  mean CareStack has been observed to mis-chart, drift, lose data, or fail in
  noise.
- Perio Voice's 98/104 replay bar, false-entry count, split count and latency
  budgets are measurements on this repository's synthetic loudspeaker fixture
  and reference hardware. They are not clinical performance or a CareStack
  comparison.
- The local product currently does not write to CareStack or any EHR. A future
  connector needs explicit authentication, transaction mapping, retry/idempotency
  rules, audit retention, consent, and a tenant-level configuration agreement.
- Negative gingival-margin speech is an open product decision. Do not describe
  the current recession parser as supporting CareStack's ALT/Option negative
  manual-entry path.

## Handoff questions for a real competitive study

Before making a product or purchasing comparison, obtain written answers or
consented measurements for: CareStack Voice Perio offline behavior; endpoint and
final latency distributions on the same hardware; handling of background speech
and operatory noise; exact audit/provenance and late-edit semantics; tenant
configuration export; and integration retry/idempotency. None is answered by the
public pages cited above, so filling in those blanks from intuition would be an
unsupported claim.
