import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../src/App';
import TestApp from './TestApp';
import { TEST_ACCOUNT } from './accountFixture';

afterEach(() => {
  window.location.hash = '';
  document.documentElement.removeAttribute('data-theme');
  try {
    window.localStorage.clear();
  } catch {
    // ignored
  }
});

async function goTo(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('link', { name }));
}

describe('page navigation', () => {
  it('defaults to Perio test when there is no route', () => {
    render(<App initialAccount={TEST_ACCOUNT} />);
    expect(screen.getByRole('heading', { name: 'Periodontal examination' })).toBeInTheDocument();
  });

  it('navigates between all three pages by clicking the top navigation links', async () => {
    const user = userEvent.setup();
    render(<App initialAccount={TEST_ACCOUNT} />);

    await goTo(user, 'Profile');
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument();

    await goTo(user, 'Graph');
    expect(screen.getByRole('heading', { name: 'Graph' })).toBeInTheDocument();

    await goTo(user, 'Perio test');
    expect(screen.getByRole('heading', { name: 'Periodontal examination' })).toBeInTheDocument();
  });

  it('opens the right page from a deep-linked URL hash, and sends unknown routes to Perio test', async () => {
    window.location.hash = '#/profile';
    render(<App initialAccount={TEST_ACCOUNT} />);
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument();

    window.location.hash = '#/graph';
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Graph' })).toBeInTheDocument());

    window.location.hash = '#/nowhere';
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Periodontal examination' })).toBeInTheDocument());
  });

  it('moves focus to the page heading on navigation and sets a matching title', async () => {
    const user = userEvent.setup();
    render(<App initialAccount={TEST_ACCOUNT} />);
    await goTo(user, 'Profile');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Profile' })).toHaveFocus());
    expect(document.title).toMatch(/profile/i);
  });
});

describe('Profile page', () => {
  it('holds voice enrollment, account details, the dark-theme switch, and the enrolled-clinician switch (off by default)', async () => {
    const user = userEvent.setup();
    render(<App initialAccount={TEST_ACCOUNT} />);
    await goTo(user, 'Profile');

    expect(screen.getByRole('button', { name: /enrol my voice/i })).toBeInTheDocument();
    const accountDetails = screen.getByRole('region', { name: /signed-in account/i });
    expect(within(accountDetails).getByText(TEST_ACCOUNT.name)).toBeInTheDocument();
    expect(within(accountDetails).getByText(TEST_ACCOUNT.email)).toBeInTheDocument();

    const clinicianSwitch = screen.getByRole('checkbox', { name: /require the enrolled clinician/i });
    expect(clinicianSwitch).not.toBeChecked();

    expect(screen.getByRole('checkbox', { name: /dark theme/i })).not.toBeChecked();
  });
});

describe('Perio test page', () => {
  it('holds capture controls, the latency/metrics panel, and the tooth chart in its slot', () => {
    render(<App initialAccount={TEST_ACCOUNT} />);
    expect(screen.getByRole('button', { name: 'Start microphone recognition' })).toBeInTheDocument();
    expect(screen.getByLabelText('Pipeline decisions this session')).toBeInTheDocument();

    const slot = screen.getByTestId('tooth-chart-slot');
    expect(within(slot).getByRole('button', { name: /^Tooth 1:/ })).toBeInTheDocument();
    expect(within(slot).getByRole('button', { name: /^Tooth 32:/ })).toBeInTheDocument();
  });
});

describe('Graph page', () => {
  it('shows the live exam in the graph slot, with the Excel download', async () => {
    const user = userEvent.setup();
    render(<TestApp />);
    // Chart on the Perio test page first: the Graph page must read the same live
    // session, not a private empty one.
    await user.type(screen.getByLabelText('Transcript simulator'), 'three four five');
    await user.click(screen.getByRole('button', { name: 'Process' }));
    await goTo(user, 'Graph');

    const slot = screen.getByTestId('graph-slot');
    expect(screen.getByRole('button', { name: /download excel/i })).toBeInTheDocument();
    expect(within(slot).queryByTestId('perio-graphs-empty')).not.toBeInTheDocument();
  });
});

describe('removed settings', () => {
  it('never shows the continuous-charting or relevance-shadow toggles on any page', async () => {
    const user = userEvent.setup();
    render(<App initialAccount={TEST_ACCOUNT} />);

    for (const name of ['Perio test', 'Profile', 'Graph']) {
      await goTo(user, name);
      // Continuous charting is core behaviour now: its state may be shown (and
      // switched by voice), but there must be no control to turn it off.
      for (const role of ['checkbox', 'switch'] as const) {
        expect(screen.queryByRole(role, { name: /continuous charting/i })).not.toBeInTheDocument();
        expect(screen.queryByRole(role, { name: /relevance shadow/i })).not.toBeInTheDocument();
      }
      expect(screen.queryByText(/relevance shadow mode/i)).not.toBeInTheDocument();
    }
  });
});

describe('dark theme', () => {
  it('toggling the Profile switch sets data-theme="dark" on <html> and persists it', async () => {
    const user = userEvent.setup();
    render(<App initialAccount={TEST_ACCOUNT} />);
    await goTo(user, 'Profile');

    const themeSwitch = screen.getByRole('checkbox', { name: /dark theme/i });
    await user.click(themeSwitch);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('perio-voice.theme')).toBe('dark');
  });
});

describe('session continuity', () => {
  it('keeps charted values after navigating away and back', async () => {
    const user = userEvent.setup();
    render(<TestApp />);

    const input = screen.getByLabelText('Transcript simulator');
    await user.type(input, 'three four five');
    await user.click(screen.getByRole('button', { name: 'Process' }));
    expect(screen.getByLabelText('MB probing depth 3')).toBeInTheDocument();

    await goTo(user, 'Graph');
    expect(screen.queryByLabelText('MB probing depth 3')).not.toBeInTheDocument();

    await goTo(user, 'Perio test');
    expect(within(screen.getByRole('main')).getByLabelText('MB probing depth 3')).toBeInTheDocument();
  });
});
