import { render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import App from '../src/App';

describe('accessibility', () => {
  it('has no automated accessibility violations in its initial state', async () => {
    const { container } = render(<App />);
    // jsdom has no canvas renderer, so axe cannot evaluate computed color contrast.
    // Token contrast is reviewed separately; all other automated rules stay enabled.
    const results = await axe(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it('exposes named controls and live regions for the clinical workflow', () => {
    render(<App />);
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('button', { name: 'Start microphone recognition' })).toBeInTheDocument();
    expect(screen.getByLabelText('Current tooth')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Three-site sequence completion' })).toBeInTheDocument();
    expect(screen.getByLabelText('Example clinical phrases')).toBeInTheDocument();
  });
});
