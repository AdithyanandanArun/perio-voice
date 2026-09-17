import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import {
  FixtureRecorder,
  type DentalFixtureManifest,
} from '../src/components/FixtureRecorder';

const manifest: DentalFixtureManifest = {
  schemaVersion: 1,
  fixtureVersion: 'test.1',
  sampleRate: 16_000,
  passes: ['quiet', 'noise'],
  scenarios: [
    {
      id: 'chartable-case',
      cohort: 'clean',
      note: 'a normal charting phrase',
      utterances: [{ id: 'chartable-case-u01', prompt: 'three four five' }],
      expect: { records: [] },
    },
    {
      id: 'control-case',
      cohort: 'conversational',
      note: 'must not reach the chart',
      utterances: [
        { id: 'control-case-u01', prompt: 'please pass the mirror', chartable: false },
      ],
      expect: { records: [] },
    },
  ],
};

afterEach(() => {
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('fixture recorder visibility', () => {
  it('is hidden without the explicit recording query switch', () => {
    render(<App />);
    expect(screen.queryByRole('heading', { name: /dental speech fixture recorder/i }))
      .not.toBeInTheDocument();
  });

  it('is mounted in a development build only when record=1', () => {
    window.history.replaceState({}, '', '/?record=1');
    render(<App />);
    expect(screen.getByRole('heading', { name: /dental speech fixture recorder/i }))
      .toBeInTheDocument();
    expect(screen.getByText(/never record a patient/i)).toBeInTheDocument();
  });
});

describe('fixture recording workflow', () => {
  it('uploads raw PCM to the exact opted-in fixture route', async () => {
    const user = userEvent.setup();
    const pcm = new Blob([new Uint8Array([4, 0])], { type: 'application/octet-stream' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    render(<FixtureRecorder manifest={manifest} capture={vi.fn().mockResolvedValue(pcm)} />);

    await user.click(screen.getByRole('button', { name: 'Record this prompt' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/fixture?pass=quiet&id=chartable-case-u01',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('traverses every phrase in quiet order before the noise pass and reports progress', async () => {
    const user = userEvent.setup();
    const firstPcm = new Blob([new Uint8Array([1, 0])]);
    const secondPcm = new Blob([new Uint8Array([2, 0])]);
    const capture = vi.fn()
      .mockResolvedValueOnce(firstPcm)
      .mockResolvedValueOnce(secondPcm);
    const upload = vi.fn().mockResolvedValue(undefined);
    render(<FixtureRecorder manifest={manifest} capture={capture} upload={upload} />);

    expect(screen.getByText('three four five')).toBeInTheDocument();
    expect(screen.getByText('Quiet-room pass')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record this prompt' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenLastCalledWith(expect.objectContaining({
      pass: 'quiet',
      id: 'chartable-case-u01',
      pcm: firstPcm,
      signal: expect.any(AbortSignal),
    }));

    expect(await screen.findByText('please pass the mirror')).toBeInTheDocument();
    expect(screen.getByText('non-chartable control')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record this prompt' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload).toHaveBeenLastCalledWith(expect.objectContaining({
      pass: 'quiet',
      id: 'control-case-u01',
      pcm: secondPcm,
    }));

    expect(await screen.findByText('Loudspeaker-noise pass')).toBeInTheDocument();
    expect(screen.getByText(/never include live patient or bystander speech/i))
      .toBeInTheDocument();
    expect(screen.getByText('2 of 4 clips saved')).toBeInTheDocument();
    expect(screen.getByText('three four five')).toBeInTheDocument();
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('retries a failed upload without recording the phrase again', async () => {
    const user = userEvent.setup();
    const pcm = new Blob([new Uint8Array([7, 0])]);
    const capture = vi.fn().mockResolvedValue(pcm);
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error('local disk is full'))
      .mockResolvedValueOnce(undefined);
    render(<FixtureRecorder manifest={manifest} capture={capture} upload={upload} />);

    await user.click(screen.getByRole('button', { name: 'Record this prompt' }));
    expect(await screen.findByText('local disk is full')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry upload' }));

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0].pcm).toBe(pcm);
    expect(upload.mock.calls[1][0].pcm).toBe(pcm);
    expect(await screen.findByText('please pass the mirror')).toBeInTheDocument();
  });

  it('refuses an empty capture instead of uploading a false-success fixture', async () => {
    const user = userEvent.setup();
    const capture = vi.fn().mockResolvedValue(new Blob());
    const upload = vi.fn().mockResolvedValue(undefined);
    render(<FixtureRecorder manifest={manifest} capture={capture} upload={upload} />);

    await user.click(screen.getByRole('button', { name: 'Record this prompt' }));
    expect(await screen.findByText(/no pcm samples were captured/i)).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByText('three four five')).toBeInTheDocument();
  });

  it('aborts an in-flight capture when the recorder unmounts', async () => {
    const user = userEvent.setup();
    let observedSignal: AbortSignal | undefined;
    const capture = vi.fn((
      _seconds: number,
      options: { signal?: AbortSignal } = {},
    ) => new Promise<Blob>((_resolve, reject) => {
      observedSignal = options.signal;
      options.signal?.addEventListener('abort', () => {
        reject(new DOMException('cancelled', 'AbortError'));
      }, { once: true });
    }));
    const { unmount } = render(
      <FixtureRecorder manifest={manifest} capture={capture} upload={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'Record this prompt' }));
    await waitFor(() => expect(observedSignal).toBeDefined());
    unmount();
    expect(observedSignal?.aborted).toBe(true);
  });
});
