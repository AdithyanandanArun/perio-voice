import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import App from '../src/App';
import { TEST_ACCOUNT } from './accountFixture';

describe('clinical platform surface', () => {
  it('shows account navigation and the focused charting workspace', () => {
    render(<App initialAccount={TEST_ACCOUNT} />);
    expect(screen.getByRole('complementary', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Charting' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Voice profile' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Periodontal examination' })).toBeInTheDocument();
  });

  it('keeps simulators and sample phrases off the normal product surface', () => {
    render(<App initialAccount={TEST_ACCOUNT} />);
    expect(screen.queryByLabelText('Transcript simulator')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Example clinical phrases')).not.toBeInTheDocument();
    expect(screen.queryByText('Development tools')).not.toBeInTheDocument();
  });

  it('uses a restrained token system without gradients or neon palette remnants', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).not.toMatch(/gradient/i);
    expect(css).not.toContain('#22d3ee');
    expect(css).not.toContain('#061316');
  });

  it('has no automated accessibility violations in the signed-in product surface', async () => {
    const { container } = render(<App initialAccount={TEST_ACCOUNT} />);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
