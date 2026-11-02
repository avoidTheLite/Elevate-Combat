import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FoundationPreview } from './FoundationPreview.tsx';

function choice(node: string, outcome: 'Capture' | 'Raze'): void {
  fireEvent.click(
    within(screen.getByRole('group', { name: node })).getByRole('button', {
      name: new RegExp(outcome),
    }),
  );
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: composed capture review example', () => {
  it('prices the whole batch, allows revising choices, then commits capture and unowned ruins', () => {
    render(<FoundationPreview />);
    choice('Crossroads', 'Capture');
    choice('Ridge Outpost', 'Capture');
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
    choice('Ridge Outpost', 'Raze');
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(screen.getByText(/OUTCOMES COMMITTED/)).toBeInTheDocument();
    expect(screen.getByText('Unowned')).toBeInTheDocument();
    expect(screen.getByText('Ruined')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByText('closed')).toBeInTheDocument();
    expect(screen.getByText(/no building operations this turn/i)).toBeInTheDocument();
  });

  it('restores independent pending choices and phase after reset without partial transfer', () => {
    render(<FoundationPreview />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Scenario' }), {
      target: { value: 'turn-start-after-income' },
    });
    choice('Crossroads', 'Capture');
    fireEvent.click(screen.getByRole('button', { name: 'Save review state' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Scenario' }), {
      target: { value: 'manual-battle-end' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restore review state' }));
    expect(screen.getByRole('combobox', { name: 'Scenario' })).toHaveValue(
      'turn-start-after-income',
    );
    expect(
      within(screen.getByRole('group', { name: 'Crossroads' })).getByRole('button', {
        name: /Capture/,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
    choice('Ridge Outpost', 'Raze');
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText(/ordinary building point/i)).toBeInTheDocument();
    expect(screen.getByText(/No income, deployment or resupply was granted/i)).toBeInTheDocument();
  });
});
