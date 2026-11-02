import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FoundationCaptureBatch, FoundationCaptureOutcome } from '@iron-ridge/engine';
import { CaptureChoicePanel, type CaptureChoicePanelProps } from './CaptureChoicePanel.tsx';

/** Synthetic fixture prices are explicit test inputs, not production defaults. */
function batch(): FoundationCaptureBatch {
  return {
    request: { requestId: 'capture-batch', expectedVersion: 0 },
    openedVersion: 1,
    team: 'A',
    ownerTurnId: 'A-turn-1',
    event: { kind: 'turn-start-after-income', incomeReceiptId: 'income-1' },
    costs: { capture: 7, raze: 3 },
    candidates: ['north', 'west'].map((id, index) => ({
      node: {
        id,
        mainHex: `${index},0`,
        centerSubHex: `${index * 5},0`,
        owner: 'B',
        buildings: [{ id: `${id}-center`, ruined: false, data: null }],
      },
      facts: {
        nodeId: id,
        liveGarrisonUnitIds: [],
        liveCenterOccupants: [{ unitId: `attacker-${id}`, team: 'A' }],
        liveHostileMainHexUnitIds: [],
        commanders: [],
      },
    })),
    choices: [],
  };
}

function choose(
  prior: FoundationCaptureBatch,
  nodeId: string,
  outcome: FoundationCaptureOutcome,
): FoundationCaptureBatch {
  const version = prior.openedVersion + prior.choices.length;
  return {
    ...prior,
    choices: [
      ...prior.choices,
      {
        request: {
          requestId: `selection-${version}`,
          expectedVersion: version,
          batchId: prior.request.requestId,
          nodeId,
          outcome,
        },
        resultingVersion: version + 1,
      },
    ],
  };
}

function props(overrides: Partial<CaptureChoicePanelProps> = {}): CaptureChoicePanelProps {
  return {
    batch: batch(),
    currentTeam: 'A',
    commandPoints: 10,
    onSelect: vi.fn(),
    onConfirm: vi.fn(),
    nodeLabels: { north: 'North Watch', west: 'West Road' },
    ...overrides,
  };
}

function Harness(input: CaptureChoicePanelProps): React.ReactElement {
  const [pending, setPending] = useState(input.batch);
  return (
    <CaptureChoicePanel
      {...input}
      batch={pending}
      onSelect={(nodeId, outcome) => {
        input.onSelect(nodeId, outcome);
        setPending((previous) => (previous ? choose(previous, nodeId, outcome) : null));
      }}
    />
  );
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: CaptureChoicePanel', () => {
  it('renders nothing without a pending batch', () => {
    const { container } = render(<CaptureChoicePanel {...props({ batch: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers named independent choices with authoritative costs and no default selection', () => {
    render(<CaptureChoicePanel {...props()} />);
    expect(screen.getByRole('region', { name: 'Node outcome' })).toBeInTheDocument();
    const north = within(screen.getByRole('group', { name: 'North Watch' }));
    expect(north.getByRole('button', { name: 'Capture Node North Watch (7 CP)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(north.getByRole('button', { name: 'Raze Node North Watch (3 CP)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(north.getByRole('button', { name: 'Do nothing North Watch (0 CP)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('group', { name: 'West Road' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Choices0/2');
    expect(screen.getByRole('button', { name: 'Confirm all choices' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /leave|skip/i })).not.toBeInTheDocument();
  });

  it('confirms only a complete affordable batch, passing its stable ID once', () => {
    const input = props();
    render(<Harness {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture Node North Watch (7 CP)' }));
    expect(input.onSelect).toHaveBeenLastCalledWith('north', 'capture');
    expect(screen.getByRole('status')).toHaveTextContent('Choices1/2');
    expect(screen.getByRole('button', { name: 'Confirm all choices' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Raze Node West Road (3 CP)' }));
    expect(input.onSelect).toHaveBeenLastCalledWith('west', 'raze');
    expect(screen.getByRole('status')).toHaveTextContent('Selected cost10 CP');
    expect(screen.getByRole('status')).toHaveTextContent('CP after confirmation0');
    const confirm = screen.getByRole('button', { name: 'Confirm all choices' });
    expect(confirm).toBeEnabled();
    expect(input.onConfirm).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(input.onConfirm).toHaveBeenCalledExactlyOnceWith('capture-batch');
  });

  it('permits editing an unaffordable selection before committing without charging earlier choices', () => {
    const input = props();
    render(<Harness {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture Node North Watch (7 CP)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture Node West Road (7 CP)' }));
    expect(screen.getByRole('alert')).toHaveTextContent('need 4 more CP');
    expect(screen.getByRole('button', { name: 'Confirm all choices' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Raze Node North Watch (3 CP)' }));
    expect(screen.getByRole('button', { name: 'Capture Node North Watch (7 CP)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Raze Node North Watch (3 CP)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Selected cost10 CP');
    expect(screen.getByRole('status')).toHaveTextContent('Available CP10');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm all choices' })).toBeEnabled();
    expect(input.onConfirm).not.toHaveBeenCalled();
  });

  it('stays fully controlled until its parent supplies updated choices', () => {
    const input = props();
    render(<CaptureChoicePanel {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture Node North Watch (7 CP)' }));
    expect(input.onSelect).toHaveBeenCalledExactlyOnceWith('north', 'capture');
    expect(screen.getByRole('button', { name: 'Capture Node North Watch (7 CP)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(input.batch?.choices).toHaveLength(0);
  });

  it('can do nothing at every node with zero CP without choosing a paid outcome', () => {
    const input = props({ commandPoints: 0 });
    render(<Harness {...input} />);
    expect(screen.getByRole('button', { name: 'Confirm all choices' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Do nothing North Watch (0 CP)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Do nothing West Road (0 CP)' }));
    expect(screen.getByRole('status')).toHaveTextContent('Selected cost0 CP');
    expect(screen.getByRole('status')).toHaveTextContent('CP after confirmation0');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm all choices' }));
    expect(input.onConfirm).toHaveBeenCalledExactlyOnceWith('capture-batch');
    expect(input.onSelect).toHaveBeenNthCalledWith(1, 'north', 'none');
    expect(input.onSelect).toHaveBeenNthCalledWith(2, 'west', 'none');
  });

  it('can mix Raze and Do nothing when razing the whole batch would exceed CP', () => {
    render(<Harness {...props({ commandPoints: 5 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Raze Node North Watch (3 CP)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Raze Node West Road (3 CP)' }));
    expect(screen.getByRole('button', { name: 'Confirm all choices' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('choose Do nothing');
    fireEvent.click(screen.getByRole('button', { name: 'Do nothing West Road (0 CP)' }));
    expect(screen.getByRole('status')).toHaveTextContent('Selected cost3 CP');
    expect(screen.getByRole('button', { name: 'Confirm all choices' })).toBeEnabled();
  });

  it('offers Do nothing even when both paid outcomes are affordable', () => {
    const input = props({ commandPoints: 100 });
    render(<Harness {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Do nothing North Watch (0 CP)' }));
    expect(input.onSelect).toHaveBeenCalledExactlyOnceWith('north', 'none');
    expect(screen.getByRole('button', { name: 'Do nothing North Watch (0 CP)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Selected cost0 CP');
  });

  it('restores the latest persisted choice and responds to a reduced CP balance', () => {
    const pending = choose(
      choose(choose(batch(), 'north', 'capture'), 'north', 'raze'),
      'west',
      'raze',
    );
    const input = props({ batch: pending, commandPoints: 6 });
    const { rerender } = render(<CaptureChoicePanel {...input} />);
    expect(screen.getByRole('button', { name: 'Raze Node North Watch (3 CP)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Selected cost6 CP');
    expect(screen.getByRole('button', { name: 'Confirm all choices' })).toBeEnabled();
    rerender(<CaptureChoicePanel {...input} commandPoints={5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm all choices' }));
    expect(input.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm all choices' })).toBeDisabled();
  });

  it.each<{
    event: FoundationCaptureBatch['event'];
    explanation: RegExp;
  }>([
    {
      event: { kind: 'turn-start-after-income', incomeReceiptId: 'paid' },
      explanation:
        /Income has already resolved\. Capture Node grants building work.*up to two with an eligible engineer/,
    },
    {
      event: { kind: 'manual-battle-end', battleId: 'battle' },
      explanation:
        /After this battle, Capture Node updates network benefits.*no building work, income, deployment or resupply/,
    },
    {
      event: { kind: 'strategic-movement', movementReceiptId: 'move' },
      explanation:
        /After movement, Capture Node updates network benefits.*no building work, income, deployment or resupply/,
    },
  ])('explains the $event.kind reward window', ({ event, explanation }) => {
    render(<CaptureChoicePanel {...props({ batch: { ...batch(), event } })} />);
    const region = screen.getByRole('region', { name: 'Node outcome' });
    expect(region).toHaveAccessibleDescription(explanation);
    expect(screen.getByText(/Raze Node damages the entire node/)).toHaveTextContent(
      'Raze Node uses no node work',
    );
  });

  it('disables edits and confirmation for another team or while confirmation is in flight', () => {
    const pending = choose(choose(batch(), 'north', 'raze'), 'west', 'raze');
    const input = props({ batch: pending, currentTeam: 'B' });
    const { rerender } = render(<CaptureChoicePanel {...input} />);
    expect(screen.getByText('Waiting for ALPHA to resolve these choices.')).toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    rerender(<CaptureChoicePanel {...input} currentTeam="A" busy />);
    expect(screen.getByRole('region', { name: 'Node outcome' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirming choices…' })).toBeDisabled();
    expect(input.onConfirm).not.toHaveBeenCalled();
  });

  it('never substitutes default prices when pricing is unavailable', () => {
    const input = props({ batch: { ...batch(), costs: { capture: Number.NaN, raze: 3 } } });
    render(<CaptureChoicePanel {...input} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Costs or available CP are unavailable');
    expect(screen.getByRole('button', { name: 'Capture Node North Watch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirm all choices' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Selected costUnavailable');
  });

  it('shows a controller rejection without discarding current selections', () => {
    const pending = choose(choose(batch(), 'north', 'raze'), 'west', 'raze');
    render(
      <CaptureChoicePanel
        {...props({ batch: pending, error: 'The battle state changed. Review these choices.' })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The battle state changed');
    expect(screen.getByRole('button', { name: 'Raze Node North Watch (3 CP)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
