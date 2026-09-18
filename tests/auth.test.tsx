import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { TEST_ACCOUNT } from './accountFixture';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: object, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('account access', () => {
  it('starts with a focused sign-in screen', () => {
    render(<App initialAccount={null} />);
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('offers account creation with an explicit password policy', async () => {
    const user = userEvent.setup();
    render(<App initialAccount={null} />);
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toBeRequired();
    expect(screen.getByText(/12 or more characters/i)).toBeInTheDocument();
  });

  it('opens the clinical workspace after a successful sign in', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ account: TEST_ACCOUNT })));
    render(<App initialAccount={null} />);
    await user.type(screen.getByLabelText('Email address'), 'maya@example.com');
    await user.type(screen.getByLabelText('Password'), 'charting-safe-42');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Periodontal examination' }))
      .toBeInTheDocument();
    expect(screen.getByText('Maya Patel')).toBeInTheDocument();
  });

  it('shows a server authentication error without losing the form', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { detail: 'Email or password is incorrect.' },
      401,
    )));
    render(<App initialAccount={null} />);
    await user.type(screen.getByLabelText('Email address'), 'maya@example.com');
    await user.type(screen.getByLabelText('Password'), 'incorrect-pass-88');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(screen.getByLabelText('Email address')).toHaveValue('maya@example.com');
  });

  it('resumes a valid server session on initial load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ account: TEST_ACCOUNT })));
    render(<App />);
    expect(screen.getByText(/opening your clinical workspace/i)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Periodontal examination' }))
      .toBeInTheDocument();
  });

  it('returns to sign in when the hygienist signs out', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<App initialAccount={TEST_ACCOUNT} />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument());
  });
});
