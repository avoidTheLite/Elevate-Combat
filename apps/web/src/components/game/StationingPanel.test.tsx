import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StationingPanel, type StationingPanelProps } from './StationingPanel.tsx';

function props(overrides: Partial<StationingPanelProps> = {}): StationingPanelProps {
  return {
    team: 'A',
    currentTeam: 'A',
    candidates: [
      {
        unitId: 'infantry',
        label: 'Road Guard',
        typeId: 'ww2_rifle_infantry',
        subHex: '1,0',
        tileKind: 'road',
        hp: 8,
      },
      {
        unitId: 'engineer',
        label: 'Ridge Guard',
        typeId: 'ww2_engineer',
        subHex: '2,0',
        tileKind: 'fort',
        hp: 5,
      },
    ],
    selectedUnitIds: [],
    onToggle: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: deliberate stationing controls', () => {
  it('permits choosing none and explains stationary control without an engineer qualification', () => {
    const input = props();
    render(<StationingPanel {...input} />);
    expect(screen.getByText(/Fortified tile/)).toBeInTheDocument();
    expect(screen.getByText(/cannot move or pursue/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Station Ridge Guard at 2,0' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue without stationing' }));
    expect(input.onConfirm).toHaveBeenCalledExactlyOnceWith();
    expect(input.onToggle).not.toHaveBeenCalled();
  });

  it('sends selection through the controller and restores the provided saved choices', () => {
    const input = props();
    const { rerender } = render(<StationingPanel {...input} />);
    const road = screen.getByRole('checkbox', { name: 'Station Road Guard at 1,0' });
    fireEvent.click(road);
    expect(input.onToggle).toHaveBeenCalledExactlyOnceWith('infantry', true);
    expect(road).not.toBeChecked();
    rerender(<StationingPanel {...input} selectedUnitIds={['infantry']} />);
    expect(road).toBeChecked();
    expect(screen.getByText('Units staying behind')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stationed units' }));
    expect(input.onConfirm).toHaveBeenCalledExactlyOnceWith();
  });

  it('cannot issue another player’s stationing decision', () => {
    const input = props({ currentTeam: 'B' });
    render(<StationingPanel {...input} />);
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue without stationing' })).toBeDisabled();
    expect(screen.getByText('Waiting for ALPHA to choose.')).toBeInTheDocument();
  });
});
