/**
 * What to read while the microphone records a sample. Each takes about as long
 * as the recording at a normal pace, and they mix charting language with
 * ordinary chairside talk because the profile has to recognise both. Each new
 * sample gets the next passage, so a multi-sample profile hears varied speech.
 */
export const ENROLLMENT_PASSAGES = [
  'Tooth fourteen buccal, probing depths three four five, bleeding on probing, and a little plaque near the gumline.',
  'Moving to the lingual side now: two three two, no suppuration, mobility grade one, and recession of two millimetres.',
  'Please rinse and relax for a moment while I measure the upper molars, then we will check the lower front teeth.',
  'Furcation class two on tooth thirty, some calculus along the margin, and the pocket readings there are four five four.',
] as const;
