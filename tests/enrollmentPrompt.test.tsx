import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SpeakerPanel } from '../src/components/SpeakerPanel';
import { ENROLLMENT_PASSAGES } from '../src/speech/enrollmentPassages';

const noop = () => undefined;

function panel(samples: number, enrolling = false) {
  return render(
    <SpeakerPanel
      enrollment={{ enrolled: samples > 0, samples } as never}
      verdict={null}
      enrolling={enrolling}
      supported
      onEnroll={noop}
      onRevoke={noop}
    />,
  );
}

describe('enrollment reading prompt', () => {
  it('shows a passage to read before the first sample', () => {
    panel(0);
    expect(screen.getByText(`“${ENROLLMENT_PASSAGES[0]}”`)).toBeInTheDocument();
    expect(screen.getByText(/Press “Enrol my voice”/)).toBeInTheDocument();
  });

  it('asks for a different passage for each extra sample', () => {
    panel(1);
    expect(screen.getByText(`“${ENROLLMENT_PASSAGES[1]}”`)).toBeInTheDocument();
    expect(screen.getByText(/Press “Add another sample”/)).toBeInTheDocument();
  });

  it('tells the clinician to read now while recording', () => {
    panel(0, true);
    expect(screen.getByText(/Recording for 6 seconds — read this aloud now/)).toBeInTheDocument();
  });

  it('keeps every passage long enough to fill the recording', () => {
    for (const passage of ENROLLMENT_PASSAGES) expect(passage.split(' ').length).toBeGreaterThanOrEqual(15);
  });
});
