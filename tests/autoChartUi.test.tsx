import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import App from '../src/App';

interface HarnessFinal {
  transcript: string;
  timing: { startedAt: number; observedAt: number };
  words: never[];
  utteranceId: number | null;
  audioMs: number | null;
  decodeMs: number | null;
  speaker: null;
  observedVersion: number | null;
}

const harness = vi.hoisted(() => ({
  onFinal: null as null | ((final: HarnessFinal) => void),
}));

vi.mock('../src/speech/useLocalAsr', () => ({
  useLocalAsr: ({ onFinal }: { onFinal: typeof harness.onFinal }) => {
    harness.onFinal = onFinal;
    return {
      supported: true,
      status: 'processing',
      listening: true,
      interimTranscript: '',
      error: null,
      model: { name: 'large-v3', device: 'cuda', computeType: 'int8_float16' },
      runtime: null,
      audioLevel: 0.1,
      latestDecodeMs: 15,
      speaker: null,
      cadence: null,
      enrollment: { enrolled: false, samples: 0, voicedMs: 0 },
      enrolling: false,
      start: vi.fn(),
      stop: vi.fn(),
      retry: vi.fn(),
      declareExpectation: vi.fn(),
      enroll: vi.fn(),
      revokeEnrollment: vi.fn(),
    };
  },
}));

function final(transcript: string): HarnessFinal {
  return {
    transcript,
    timing: { startedAt: 10, observedAt: 35 },
    words: [],
    utteranceId: 7,
    audioMs: 820,
    decodeMs: 15,
    speaker: null,
    observedVersion: null,
  };
}

const batch = 'tooth fourteen buccal three four five; tooth fifteen lingual two three four';

describe('automatic chart UI', () => {
  it('explains the strict batch contract through the labelled simulator and safely processes it', async () => {
    const user = userEvent.setup();
    render(<App />);

    const simulator = screen.getByLabelText('Transcript simulator');
    expect(simulator.tagName).toBe('TEXTAREA');
    expect(simulator).toHaveAttribute('aria-describedby', 'auto-chart-help');
    expect(screen.getByText(/automatic batches require a tooth and surface in every directive/i)).toBeInTheDocument();

    await user.type(simulator, batch);
    await user.click(screen.getByRole('button', { name: 'Process' }));
    expect(screen.getByLabelText('ML probing depth 2')).toBeInTheDocument();
    expect(screen.getByLabelText('L probing depth 3')).toBeInTheDocument();
    expect(screen.getByLabelText('DL probing depth 4')).toBeInTheDocument();
  });

  it('routes an ASR final through the same batch transaction', () => {
    render(<App />);
    act(() => harness.onFinal?.(final(batch)));
    expect(screen.getByLabelText('ML probing depth 2')).toBeInTheDocument();
    expect(screen.getAllByText('Depths recorded')).toHaveLength(2);
  });

  it('announces a rejected batch and preserves the active chart', async () => {
    const user = userEvent.setup();
    render(<App />);
    const simulator = screen.getByLabelText('Transcript simulator');
    await user.type(simulator, 'tooth fourteen buccal three four five; two three four');
    fireEvent.submit(simulator.closest('form') as HTMLFormElement);

    expect(screen.getByLabelText('MB probing depth not recorded')).toBeInTheDocument();
    expect(screen.getByText(/automatic charting refused/i)).toBeInTheDocument();
  });

  it('has no automated accessibility violations with the safe batch guidance visible', async () => {
    const { container } = render(<App />);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
