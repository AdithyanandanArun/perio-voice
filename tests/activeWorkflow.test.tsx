import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from './TestApp';

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

const asrHarness = vi.hoisted(() => ({
  onFinal: null as null | ((final: HarnessFinal) => void),
}));

function spoken(transcript: string, startedAt: number, observedAt: number): HarnessFinal {
  return {
    transcript,
    timing: { startedAt, observedAt },
    words: [],
    utteranceId: 1,
    audioMs: 640,
    decodeMs: 16,
    speaker: null,
    observedVersion: null,
  };
}

vi.mock('../src/speech/useLocalAsr', () => ({
  useLocalAsr: ({ onFinal }: { onFinal: typeof asrHarness.onFinal }) => {
    asrHarness.onFinal = onFinal;
    return {
      supported: true,
      status: 'processing',
      listening: true,
      interimTranscript: 'three four',
      error: null,
      model: { name: 'tiny.en', device: 'cpu', computeType: 'int8' },
      runtime: null,
      audioLevel: 0.2,
      latestDecodeMs: 16,
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

describe('active ASR workflow boundary', () => {
  it('renders a partial and commits only the final transcript to the structured chart', () => {
    render(<App />);
    expect(screen.getByText('three four')).toBeInTheDocument();
    expect(screen.getAllByText('Recognizing speech').length).toBeGreaterThan(0);
    expect(screen.getByText(/tiny\.en · cpu \/ int8 · last decode 16 ms/i)).toBeInTheDocument();
    expect(screen.getByLabelText('MB probing depth not recorded')).toBeInTheDocument();

    act(() => asrHarness.onFinal?.(spoken('three four five', 10, 32)));
    expect(screen.getByLabelText('MB probing depth 3')).toBeInTheDocument();
    expect(screen.getByLabelText('B probing depth 4')).toBeInTheDocument();
    expect(screen.getByLabelText('DB probing depth 5')).toBeInTheDocument();
    expect(screen.getAllByText('22 ms')).toHaveLength(3);
    expect(screen.getByLabelText('Transcript simulator')).toBeInTheDocument();
  });

  it('ignores a final that arrives while a full session reset is draining audio', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    act(() => asrHarness.onFinal?.(spoken('three four five', 10, 20)));
    expect(screen.getByLabelText('MB probing depth 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset session' }));
    expect(screen.getByLabelText('MB probing depth not recorded')).toBeInTheDocument();
    act(() => asrHarness.onFinal?.(spoken('two three four', 21, 30)));
    expect(screen.getByLabelText('MB probing depth not recorded')).toBeInTheDocument();
  });
});
