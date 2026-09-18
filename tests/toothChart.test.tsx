import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../src/App';
import { TEST_ACCOUNT } from './accountFixture';
import { ToothChart } from '../src/components/ToothChart';
import { createInitialSession } from '../src/domain/session';
import { chartKey, emptyRecord } from '../src/domain/chart';
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
  charts?: Record<string, PerioRecord>;
  teeth?: Record<number, ToothRecord>;
}): ClinicalSession {
  const base = createInitialSession();
  return {
    ...base,
    context: { ...base.context, tooth: overrides.contextTooth ?? base.context.tooth },
    charts: { ...base.charts, ...(overrides.charts ?? {}) },
    teeth: { ...base.teeth, ...(overrides.teeth ?? {}) },
  };
}

describe('ToothChart', () => {
  it('renders all 32 permanent teeth across two arches with the correct numbers', () => {
    const session = sessionWith({});
    render(<ToothChart session={session} />);

    const upperArch = screen.getByLabelText('Upper arch, teeth 1 to 16');
    const lowerArch = screen.getByLabelText('Lower arch, teeth 17 to 32');

    for (let tooth = 1; tooth <= 16; tooth += 1) {
      expect(within(upperArch).getByRole('button', { name: new RegExp(`^Tooth ${tooth}:`) })).toBeInTheDocument();
    }
    for (let tooth = 17; tooth <= 32; tooth += 1) {
      expect(within(lowerArch).getByRole('button', { name: new RegExp(`^Tooth ${tooth}:`) })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('button', { name: /^Tooth \d+:/ })).toHaveLength(32);
  });

  it('marks the active tooth from session.context.tooth', () => {
    const session = sessionWith({ contextTooth: 19 });
    render(<ToothChart session={session} />);

    expect(screen.getByRole('button', { name: /^Tooth 19: active/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Tooth 14: inactive/ })).toBeInTheDocument();
  });

  it('derives pocket severity from the deepest probing depth and reflects it in the accessible name', () => {
    const session = sessionWith({
      charts: {
        [chartKey(14, 'buccal')]: chartedRecord({ tooth: 14, surface: 'buccal', probingDepths: [2, 3, 6] }),
      },
    });
    const first = render(<ToothChart session={session} />);
    const cell = within(first.container).getByRole('button', { name: /^Tooth 14:/ });
    expect(cell).toHaveAccessibleName(/deepest 6 mm/);
    expect(cell.className).toContain('severity-severe');
    first.unmount();

    const moderate = sessionWith({
      charts: {
        [chartKey(3, 'buccal')]: chartedRecord({ tooth: 3, surface: 'buccal', probingDepths: [4, null, null] }),
      },
    });
    const second = render(<ToothChart session={moderate} />);
    const moderateCell = within(second.container).getByRole('button', { name: /^Tooth 3:/ });
    expect(moderateCell.className).toContain('severity-moderate');
  });

  it('shows bleeding on a tooth that has it recorded', () => {
    const session = sessionWith({
      charts: {
        [chartKey(5, 'buccal')]: chartedRecord({ tooth: 5, surface: 'buccal', bleeding: true }),
      },
    });
    render(<ToothChart session={session} />);

    expect(screen.getByRole('button', { name: /^Tooth 5:.*bleeding/ })).toBeInTheDocument();
  });

  it('shows a tooth marked missing/skipped', () => {
    const session = sessionWith({
      teeth: { 9: toothRecord({ tooth: 9, missing: true }) },
    });
    render(<ToothChart session={session} />);

    const cell = screen.getByRole('button', { name: 'Tooth 9: missing' });
    expect(cell.className).toContain('is-missing');
  });

  it('clicking a tooth shows details locally without changing chart state', async () => {
    const user = userEvent.setup();
    const session = sessionWith({
      charts: {
        [chartKey(20, 'buccal')]: chartedRecord({ tooth: 20, surface: 'buccal', probingDepths: [2, 2, 2] }),
      },
    });
    const before = JSON.stringify(session);
    render(<ToothChart session={session} />);

    await user.click(screen.getByRole('button', { name: /^Tooth 20:/ }));

    expect(screen.getByRole('status')).toHaveTextContent('Tooth 20');
    expect(JSON.stringify(session)).toBe(before);
  });

  it('renders on the Perio test page inside the tooth-chart-slot', () => {
    render(<App initialAccount={TEST_ACCOUNT} />);
    const slot = document.querySelector('[data-testid="tooth-chart-slot"]') as HTMLElement;
    expect(slot).not.toBeNull();
    expect(within(slot).getByRole('heading', { name: 'Full-mouth status' })).toBeInTheDocument();
    expect(within(slot).getAllByRole('button', { name: /^Tooth \d+:/ })).toHaveLength(32);
  });
});
