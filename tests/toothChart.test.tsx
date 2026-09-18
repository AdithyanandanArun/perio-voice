import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../src/App';
import { TEST_ACCOUNT } from './accountFixture';
import { ToothChart } from '../src/components/ToothChart';
import { createInitialSession } from '../src/domain/session';
import { chartKey, emptyRecord } from '../src/domain/chart';
import { STATION_COUNT, stationIndexOf } from '../src/domain/workflow';
import type { ClinicalSession, PerioRecord, ToothRecord } from '../src/domain/types';

function chartedRecord(overrides: Partial<PerioRecord> = {}): PerioRecord {
  return {
    ...emptyRecord(overrides.tooth ?? 14, overrides.surface ?? 'buccal'),
    updatedAt: 1,
    ...overrides,
  };
}

function toothRecord(overrides: Partial<ToothRecord> = {}): ToothRecord {
  return { tooth: overrides.tooth ?? 1, mobility: null, furcation: null, missing: false, updatedAt: null, ...overrides };
}

function sessionWith(overrides: {
  contextTooth?: number;
  contextSurface?: 'buccal' | 'lingual';
  charts?: Record<string, PerioRecord>;
  teeth?: Record<number, ToothRecord>;
}): ClinicalSession {
  const base = createInitialSession();
  return {
    ...base,
    context: {
      ...base.context,
      tooth: overrides.contextTooth ?? base.context.tooth,
      surface: overrides.contextSurface ?? base.context.surface,
    },
    charts: { ...base.charts, ...(overrides.charts ?? {}) },
    teeth: { ...base.teeth, ...(overrides.teeth ?? {}) },
  };
}

describe('ToothChart', () => {
  it('renders exactly 64 cells, 32 per surface panel, with correct numbering and row placement', () => {
    const session = sessionWith({});
    render(<ToothChart session={session} />);

    const buccalPanel = screen.getByRole('region', { name: 'Buccal' }) as HTMLElement;
    const lingualPanel = screen.getByRole('region', { name: 'Lingual' }) as HTMLElement;

    const buccalUpper = within(buccalPanel).getByLabelText('Buccal upper arch, teeth 1 to 16');
    const buccalLower = within(buccalPanel).getByLabelText('Buccal lower arch, teeth 32 to 17');
    for (let tooth = 1; tooth <= 16; tooth += 1) {
      expect(
        within(buccalUpper).getByRole('button', { name: new RegExp(`^Tooth ${tooth} buccal:`) }),
      ).toBeInTheDocument();
    }
    for (let tooth = 17; tooth <= 32; tooth += 1) {
      expect(
        within(buccalLower).getByRole('button', { name: new RegExp(`^Tooth ${tooth} buccal:`) }),
      ).toBeInTheDocument();
    }
    expect(within(buccalPanel).getAllByRole('button')).toHaveLength(32);
    expect(within(lingualPanel).getAllByRole('button')).toHaveLength(32);
    expect(screen.getAllByRole('button', { name: /^Tooth \d+ (buccal|lingual):/ })).toHaveLength(64);
  });

  it('marks only the active surface, not the whole tooth', () => {
    const session = sessionWith({ contextTooth: 19, contextSurface: 'lingual' });
    render(<ToothChart session={session} />);

    expect(screen.getByRole('button', { name: /^Tooth 19 lingual: active/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Tooth 19 buccal: inactive/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Tooth 14 buccal: inactive/ })).toBeInTheDocument();
  });

  it('charting depths on the buccal surface updates only that buccal cell, leaving the lingual cell untouched', () => {
    const session = sessionWith({
      charts: {
        [chartKey(14, 'buccal')]: chartedRecord({ tooth: 14, surface: 'buccal', probingDepths: [2, 3, 6] }),
      },
    });
    render(<ToothChart session={session} />);

    const buccalCell = screen.getByRole('button', { name: /^Tooth 14 buccal:/ });
    expect(buccalCell).toHaveAccessibleName(/deepest 6 mm/);
    expect(buccalCell.className).toContain('severity-severe');

    const lingualCell = screen.getByRole('button', { name: /^Tooth 14 lingual:/ });
    expect(lingualCell).toHaveAccessibleName(/not yet charted/);
    expect(lingualCell.className).not.toContain('severity-severe');
  });

  it('derives moderate severity from a shallower deepest depth', () => {
    const session = sessionWith({
      charts: {
        [chartKey(3, 'buccal')]: chartedRecord({ tooth: 3, surface: 'buccal', probingDepths: [4, null, null] }),
      },
    });
    render(<ToothChart session={session} />);
    const cell = screen.getByRole('button', { name: /^Tooth 3 buccal:/ });
    expect(cell.className).toContain('severity-moderate');
  });

  it('shows bleeding recorded on the lingual surface only on the lingual cell', () => {
    const session = sessionWith({
      charts: {
        [chartKey(5, 'lingual')]: chartedRecord({ tooth: 5, surface: 'lingual', bleeding: true }),
      },
    });
    render(<ToothChart session={session} />);

    expect(screen.getByRole('button', { name: /^Tooth 5 lingual:.*bleeding/ })).toBeInTheDocument();
    const buccalCell = screen.getByRole('button', { name: /^Tooth 5 buccal:/ });
    expect(buccalCell).not.toHaveAccessibleName(/bleeding/);
  });

  it('marks both surfaces of a skipped/missing tooth', () => {
    const session = sessionWith({
      teeth: { 9: toothRecord({ tooth: 9, missing: true }) },
    });
    render(<ToothChart session={session} />);

    const buccalCell = screen.getByRole('button', { name: 'Tooth 9 buccal: missing' });
    const lingualCell = screen.getByRole('button', { name: 'Tooth 9 lingual: missing' });
    expect(buccalCell.className).toContain('is-missing');
    expect(lingualCell.className).toContain('is-missing');
  });

  it('clicking a surface cell only shows details locally, never changing chart state', async () => {
    const user = userEvent.setup();
    const session = sessionWith({
      charts: {
        [chartKey(20, 'buccal')]: chartedRecord({ tooth: 20, surface: 'buccal', probingDepths: [2, 2, 2] }),
      },
    });
    const before = JSON.stringify(session);
    render(<ToothChart session={session} />);

    await user.click(screen.getByRole('button', { name: /^Tooth 20 buccal:/ }));

    expect(screen.getByRole('status')).toHaveTextContent('Tooth 20 Buccal');
    expect(JSON.stringify(session)).toBe(before);
  });

  it('shows the clicked surface\'s position in STATION_ORDER, agreeing with the domain workflow import', async () => {
    const user = userEvent.setup();
    const session = sessionWith({});
    render(<ToothChart session={session} />);

    await user.click(screen.getByRole('button', { name: /^Tooth 25 lingual:/ }));

    const expectedPosition = stationIndexOf(25, 'lingual') + 1;
    expect(screen.getByRole('status')).toHaveTextContent(`Position ${expectedPosition} of ${STATION_COUNT}`);
  });

  it('renders a progression direction per row that agrees with STATION_ORDER, derived rather than hard-coded', () => {
    const session = sessionWith({});
    render(<ToothChart session={session} />);

    // Compute expected direction the same way the component must: from the
    // actual station indices of the row's first and last displayed tooth.
    const expectDirection = (surface: 'buccal' | 'lingual', first: number, last: number) =>
      stationIndexOf(last, surface) >= stationIndexOf(first, surface) ? 'right' : 'left';

    expect(screen.getByLabelText('Buccal upper arch, teeth 1 to 16')).toHaveAttribute(
      'data-direction',
      expectDirection('buccal', 1, 16),
    );
    expect(screen.getByLabelText('Buccal lower arch, teeth 32 to 17')).toHaveAttribute(
      'data-direction',
      expectDirection('buccal', 32, 17),
    );
    expect(screen.getByLabelText('Lingual upper arch, teeth 1 to 16')).toHaveAttribute(
      'data-direction',
      expectDirection('lingual', 1, 16),
    );
    expect(screen.getByLabelText('Lingual lower arch, teeth 32 to 17')).toHaveAttribute(
      'data-direction',
      expectDirection('lingual', 32, 17),
    );
  });

  it('renders on the Perio test page inside the tooth-chart-slot', () => {
    render(<App initialAccount={TEST_ACCOUNT} />);
    const slot = document.querySelector('[data-testid="tooth-chart-slot"]') as HTMLElement;
    expect(slot).not.toBeNull();
    expect(within(slot).getByRole('heading', { name: 'Full-mouth status' })).toBeInTheDocument();
    expect(within(slot).getAllByRole('button', { name: /^Tooth \d+ (buccal|lingual):/ })).toHaveLength(64);
  });
});
