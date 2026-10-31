import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  FreeShotPanel,
  type FreeShotPanelProps,
  type PendingFreeShotPrompt,
} from './FreeShotPanel.tsx';

function prompt(): PendingFreeShotPrompt {
  return {
    ok: true,
    status: 'choose-target',
    boundaryId: 'battle-deployed',
    trigger: 'tactical-after-deployment',
    team: 'A',
    ownerCycleId: 'A-1',
    shooterId: 'guard',
    targetIds: ['enemy-1', 'enemy-2'],
    selection: null,
  };
}

function props(overrides: Partial<FreeShotPanelProps> = {}): FreeShotPanelProps {
  return {
    prompt: prompt(),
    currentTeam: 'A',
    actors: {
      guard: { label: 'Ridge Mortar' },
      'enemy-1': { label: 'Infantry', detail: '8 HP' },
      'enemy-2': { label: 'Cavalry', detail: '6 HP' },
    },
    onSelectTarget: vi.fn(),
    onResolve: vi.fn(),
    ...overrides,
  };
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: sequential free-shot controls', () => {
  it('shows only engine-provided targets and waits for a saved explicit selection', () => {
    const input = props();
    render(<FreeShotPanel {...input} />);
    expect(screen.getByText('Ridge Mortar')).toBeInTheDocument();
    expect(screen.getByText(/normal tactical actions available/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Infantry/ }));
    expect(input.onSelectTarget).toHaveBeenCalledExactlyOnceWith('enemy-1');
    expect(screen.getByRole('button', { name: 'Fire free shot' })).toBeDisabled();
    expect(input.onResolve).not.toHaveBeenCalled();
  });

  it('resumes an already selected shot and resolves only when commanded', () => {
    const waiting = prompt();
    const selected: PendingFreeShotPrompt = {
      ...waiting,
      status: 'selected',
      selection: {
        request: {
          requestId: 'target-1',
          expectedVersion: 3,
          boundaryId: waiting.boundaryId,
          team: 'A',
          ownerCycleId: waiting.ownerCycleId,
          shooterId: 'guard',
          targetId: 'enemy-2',
        },
        resultingVersion: 4,
      },
    };
    const input = props({ prompt: selected });
    render(<FreeShotPanel {...input} />);
    expect(screen.getByRole('button', { name: /Cavalry/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Infantry/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Fire free shot' }));
    expect(input.onResolve).toHaveBeenCalledExactlyOnceWith();
    expect(input.onSelectTarget).not.toHaveBeenCalled();
  });

  it('reflects the next live queue entry rather than retaining dead targets locally', () => {
    const input = props();
    const { rerender } = render(<FreeShotPanel {...input} />);
    rerender(
      <FreeShotPanel
        {...input}
        prompt={{ ...prompt(), shooterId: 'guard-2', targetIds: ['enemy-2'] }}
      />,
    );
    expect(screen.queryByRole('button', { name: /Infantry/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Cavalry/ }));
    expect(input.onSelectTarget).toHaveBeenCalledExactlyOnceWith('enemy-2');
  });

  it('shows commander timing and blocks another player’s target selection', () => {
    render(
      <FreeShotPanel
        {...props({ currentTeam: 'B', prompt: { ...prompt(), trigger: 'strategic-after-income' } })}
      />,
    );
    expect(screen.getByText(/Choose an enemy commander/)).toBeInTheDocument();
    expect(screen.getByText('Waiting for ALPHA to choose a target.')).toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });
});
