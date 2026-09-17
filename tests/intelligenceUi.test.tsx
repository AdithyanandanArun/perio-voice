import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import type { SpeakerVerdict } from '../src/domain/types';

const harness = vi.hoisted(() => ({
  speaker: null as SpeakerVerdict | null,
  enrollment: { enrolled: false, samples: 0, voicedMs: 0 },
  enroll: vi.fn(),
  revokeEnrollment: vi.fn(),
}));

vi.mock('../src/speech/useLocalAsr', () => ({
  useLocalAsr: () => ({
    supported: false,
    status: 'unsupported',
    listening: false,
    interimTranscript: '',
    error: null,
    model: null,
    runtime: {
      protocol: 1,
      promptVersion: '2026.09.1',
      biasPrompt: true,
      denoiseProfile: 'none',
      endSilenceMs: 520,
      endpointBandMs: [300, 1100],
      cadenceAdaptive: true,
    },
    audioLevel: 0,
    latestDecodeMs: null,
    speaker: harness.speaker,
    cadence: { endSilenceMs: 430, wordsPerSecond: 3.1, pauseP90Ms: 95, samples: 4, adaptive: true },
    enrollment: harness.enrollment,
    enrolling: false,
    start: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    enroll: harness.enroll,
    revokeEnrollment: harness.revokeEnrollment,
  }),
}));

async function say(user: ReturnType<typeof userEvent.setup>, phrase: string) {
  const input = screen.getByLabelText('Transcript simulator');
  await user.clear(input);
  await user.type(input, phrase);
  await user.click(screen.getByRole('button', { name: 'Process' }));
}

beforeEach(() => {
  harness.speaker = null;
  harness.enrollment = { enrolled: false, samples: 0, voicedMs: 0 };
  vi.clearAllMocks();
});

describe('full-mouth workflow controls', () => {
  it('shows where the clinician is in the whole mouth', () => {
    render(<App />);
    const progress = screen.getByRole('progressbar', { name: 'Full-mouth charting progress' });
    expect(progress).toHaveAttribute('aria-valuemax', '192');
    expect(progress).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText(/upper left · tooth 14 buccal/i)).toBeInTheDocument();
  });

  it('advances, steps back, and reports progress as sites are charted', async () => {
    const user = userEvent.setup();
    render(<App />);
    await say(user, 'three four five');
    expect(
      screen.getByRole('progressbar', { name: 'Full-mouth charting progress' }),
    ).toHaveAttribute('aria-valuenow', '3');

    const workflow = screen.getByRole('region', { name: 'Full-mouth workflow' });
    await user.click(within(workflow).getByRole('button', { name: /next tooth/i }));
    expect(within(workflow).getByText(/tooth 15 buccal/i)).toBeInTheDocument();
    await user.click(within(workflow).getByRole('button', { name: /previous tooth/i }));
    expect(within(workflow).getByText(/tooth 14 buccal/i)).toBeInTheDocument();
  });

  it('marks a tooth absent and says so', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /skip tooth/i }));
    expect(screen.getByText(/marked absent: 14/i)).toBeInTheDocument();
  });

  it('enables undo only once there is something to reverse', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole('button', { name: /^undo$/i })).toBeDisabled();

    await say(user, 'three four five');
    const undo = screen.getByRole('button', { name: /^undo$/i });
    expect(undo).toBeEnabled();
    await user.click(undo);
    expect(screen.getByLabelText('MB probing depth not recorded')).toBeInTheDocument();

    const redo = screen.getByRole('button', { name: /^redo$/i });
    expect(redo).toBeEnabled();
    await user.click(redo);
    expect(screen.getByLabelText('MB probing depth 3')).toBeInTheDocument();
  });

  it('only offers speaker enforcement once a voice is enrolled', async () => {
    render(<App />);
    expect(screen.getByRole('checkbox', { name: /require the enrolled clinician/i })).toBeDisabled();
    expect(screen.getByText(/enrol a voice first/i)).toBeInTheDocument();
  });
});

describe('held confirmations', () => {
  it('holds uncertain speech and charts it only when the clinician approves', async () => {
    const user = userEvent.setup();
    render(<App />);
    await say(user, 'bleeding maybe');

    const panel = screen.getByRole('region', { name: 'Held for confirmation' });
    expect(within(panel).getByText('Unclear whether this was clinical')).toBeInTheDocument();
    expect(screen.getByText('Bleeding on probing').closest('.finding-row'))
      .toHaveTextContent('Not recorded');

    await user.click(within(panel).getByRole('button', { name: /chart it/i }));
    expect(screen.getByText('Yes · present')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Held for confirmation' })).not.toBeInTheDocument();
  });

  it('discards a held utterance without writing anything', async () => {
    const user = userEvent.setup();
    render(<App />);
    await say(user, 'bleeding maybe');
    const panel = screen.getByRole('region', { name: 'Held for confirmation' });
    await user.click(within(panel).getByRole('button', { name: /discard/i }));

    expect(screen.queryByRole('region', { name: 'Held for confirmation' })).not.toBeInTheDocument();
    expect(screen.getByText(/discarded after review/i)).toBeInTheDocument();
  });
});

describe('speaker attribution', () => {
  it('reports who the last utterance was attributed to', () => {
    harness.enrollment = { enrolled: true, samples: 2, voicedMs: 5_400 };
    harness.speaker = { decision: 'other', similarity: 0.41, overridden: false };
    render(<App />);
    expect(screen.getByText(/enrolled · 2 sample\(s\)/i)).toBeInTheDocument();
    expect(screen.getByText(/last utterance: another speaker/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /require the enrolled clinician/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /revoke profile/i })).toBeInTheDocument();
  });
});

describe('decision trace', () => {
  it('explains why speech was refused, stage by stage', async () => {
    const user = userEvent.setup();
    render(<App />);
    await say(user, 'can you pass me four instruments');

    const why = screen.getAllByText('Why')[0];
    await user.click(why);
    const trace = why.closest('details') as HTMLElement;
    expect(within(trace).getByText('Relevance')).toBeInTheDocument();
    expect(within(trace).getByText('block')).toBeInTheDocument();
    expect(within(trace).getByText(/request to another person/i)).toBeInTheDocument();
  });

  it('explains why a value was accepted', async () => {
    const user = userEvent.setup();
    render(<App />);
    await say(user, 'to for ate');
    expect(screen.getByLabelText('MB probing depth 2')).toBeInTheDocument();

    await user.click(screen.getAllByText('Why')[0]);
    const trace = screen.getAllByText('Why')[0].closest('details') as HTMLElement;
    expect(within(trace).getByText('Disambiguation')).toBeInTheDocument();
    expect(within(trace).getByText('to→2, for→4, ate→8')).toBeInTheDocument();
  });
});

describe('pipeline counters', () => {
  it('reports what the filter did this session', async () => {
    const user = userEvent.setup();
    render(<App />);
    await say(user, 'three four five');
    await say(user, 'can you pass me that');

    const counters = screen.getByLabelText('Pipeline decisions this session');
    expect(within(counters).getByText('Charted')).toBeInTheDocument();
    expect(within(counters).getByText('Filtered as conversation')).toBeInTheDocument();
  });
});

describe('accessibility with the intelligence layer visible', () => {
  it('has no automated violations while a confirmation is pending', async () => {
    harness.enrollment = { enrolled: true, samples: 1, voicedMs: 3_000 };
    harness.speaker = { decision: 'clinician', similarity: 0.99, overridden: false };
    const user = userEvent.setup();
    const { container } = render(<App />);
    await say(user, 'three four five');
    await say(user, 'bleeding maybe');

    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
