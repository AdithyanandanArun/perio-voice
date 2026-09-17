import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../src/App';

async function simulate(user: ReturnType<typeof userEvent.setup>, phrase: string) {
  const input = screen.getByLabelText('Transcript simulator');
  await user.clear(input);
  await user.type(input, phrase);
  await user.click(screen.getByRole('button', { name: 'Process' }));
}

describe('clinician workflow', () => {
  it('renders a clear fallback when local microphone capture is unavailable', () => {
    render(<App />);
    expect(screen.getByText(/local microphone capture is unavailable here/i)).toBeInTheDocument();
    expect(screen.getAllByText('Simulator available').length).toBeGreaterThan(0);
  });

  it('commits depths, bleeding, and a natural correction to the live chart', async () => {
    const user = userEvent.setup();
    render(<App />);

    await simulate(user, 'three four five');
    expect(screen.getByLabelText('MB probing depth 3')).toBeInTheDocument();
    expect(screen.getByLabelText('B probing depth 4')).toBeInTheDocument();
    expect(screen.getByLabelText('DB probing depth 5')).toBeInTheDocument();
    expect(screen.getByText('3 of 3 sites recorded')).toBeInTheDocument();

    await simulate(user, 'bleeding');
    expect(screen.getByText('Yes · present')).toBeInTheDocument();

    await simulate(user, 'four no three');
    expect(screen.getByLabelText('DB probing depth 3')).toBeInTheDocument();
    expect(screen.getByText(/corrected site 3 from 5 to 3 mm/i)).toBeInTheDocument();
  });

  it('changes anatomical context without overwriting the prior chart record', async () => {
    const user = userEvent.setup();
    render(<App />);
    await simulate(user, 'three four five');

    await user.selectOptions(screen.getByLabelText('Current tooth'), '15');
    await user.click(screen.getByRole('button', { name: 'Lingual' }));
    await simulate(user, 'two three four');

    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('14')).toBeInTheDocument();
    expect(within(rows[2]).getByText('15')).toBeInTheDocument();
    expect(within(rows[2]).getByText('lingual')).toBeInTheDocument();
  });

  it('surfaces protected input instead of shifting an incomplete sequence', async () => {
    const user = userEvent.setup();
    render(<App />);
    await simulate(user, 'three four');
    await simulate(user, 'five six');

    expect(screen.getByLabelText('DB probing depth not recorded')).toBeInTheDocument();
    expect(screen.getByText(/expected 1 more value; no depths were changed/i)).toBeInTheDocument();
  });
});
