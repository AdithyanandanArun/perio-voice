import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GraphPage } from '../src/pages/GraphPage';
import { createInitialSession } from '../src/domain/session';
import { chartKey, emptyRecord } from '../src/domain/chart';
import type { ClinicalSession } from '../src/domain/types';

function chartedSession(): ClinicalSession {
  const session = createInitialSession();
  return {
    ...session,
    charts: {
      ...session.charts,
      [chartKey(9, 'buccal')]: {
        ...emptyRecord(9, 'buccal'),
        probingDepths: [3, 4, 7],
        bleeding: true,
        updatedAt: 1,
      },
    },
  };
}

describe('GraphPage', () => {
  it('shows the empty state when nothing has been charted', () => {
    render(<GraphPage session={createInitialSession()} />);
    expect(screen.getByTestId('perio-graphs-empty')).toBeInTheDocument();
    expect(screen.getByText(/nothing has been charted yet/i)).toBeInTheDocument();
  });

  it('renders the charts and summary once a tooth is charted', () => {
    render(<GraphPage session={chartedSession()} />);
    expect(screen.getByTestId('perio-graphs')).toBeInTheDocument();
    expect(screen.getByText(/1 of 32 teeth charted/i)).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /probing depth chart/i })).toHaveLength(2);
  });

  it('renders without a session prop by falling back to an empty session', () => {
    render(<GraphPage />);
    expect(screen.getByTestId('perio-graphs-empty')).toBeInTheDocument();
  });

  it('has a labelled Download Excel button', () => {
    render(<GraphPage session={chartedSession()} />);
    const button = screen.getByRole('button', { name: /download excel/i });
    expect(button).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('offers the data table as an accessible alternative to the SVG chart', () => {
    render(<GraphPage session={chartedSession()} />);
    expect(screen.getByText(/show as data table/i)).toBeInTheDocument();
  });
});
