import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  campaignNodeActionChoices,
  createFoundationPlaytestConfiguration,
  createGame,
  defaultSettings,
  deserializeSave,
  setHolderPos,
  worldOf,
} from '@iron-ridge/engine';
import type { GameState } from '@iron-ridge/engine';
import { useGameStore } from '../../stores/useGameStore.ts';
import { NodePanel } from './NodePanel.tsx';

beforeEach(() => {
  localStorage.clear();
  act(() => useGameStore.getState().quit());
});

function configuredGame(): GameState {
  return createGame({
    ...defaultSettings(),
    controllers: { A: 'human', B: 'human' },
    fog: false,
    infrastructure: createFoundationPlaytestConfiguration(7, 3),
  });
}

function NodeHarness(): React.ReactElement {
  const game = useGameStore((state) => state.game)!;
  return <NodePanel game={game} mainHex={game.hq.A} canAct />;
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: node orders through the real game store', () => {
  it('executes the quoted build once, updates its work allowance and exports the same saved state', () => {
    const game = configuredGame();
    const node = game.infrastructure!.capture.nodes.find(
      (candidate) => candidate.mainHex === game.hq.A,
    )!;
    const choice = campaignNodeActionChoices(game, node.id).find(
      (candidate) => candidate.request.kind === 'build' && candidate.legal,
    )!;
    expect(choice).toBeDefined();
    act(() => useGameStore.setState({ game }));
    render(<NodeHarness />);
    fireEvent.change(screen.getByLabelText('Node order'), {
      target: { value: choice.request.requestId },
    });
    fireEvent.click(screen.getByRole('button', { name: `Carry out order (${choice.cpCost} CP)` }));
    const next = useGameStore.getState().game!;
    expect(next.cp.A).toBe(game.cp.A - choice.cpCost);
    expect(
      next.infrastructure!.capture.nodes.find((candidate) => candidate.id === node.id)!.buildings,
    ).toHaveLength(node.buildings.length + 1);
    expect(
      next.infrastructure!.capture.work.nodeSpending.find((record) => record.nodeId === node.id)
        ?.ordinarySpent,
    ).toBe(true);
    expect(screen.getByLabelText('Node order')).toHaveValue('');
    const exported = useGameStore.getState().exportSave()!;
    const restored = deserializeSave(exported.text);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.save.state).toEqual(next);
  });

  it('shows the engine refusal for an upgrade without local engineers and leaves CP untouched', () => {
    const game = configuredGame();
    const { world } = worldOf(game);
    for (const commander of game.armies.filter(
      (holder) => holder.team === 'A' && holder.kind === 'commander',
    )) {
      const remote = world.subs.find(
        (cell) => cell.main !== game.hq.A && !game.armies.some((holder) => holder.pos === cell.key),
      )!;
      setHolderPos(world, commander, remote.key);
    }
    const node = game.infrastructure!.capture.nodes.find(
      (candidate) => candidate.mainHex === game.hq.A,
    )!;
    const refused = campaignNodeActionChoices(game, node.id).find(
      (choice) => choice.request.kind === 'upgrade' && !choice.legal,
    )!;
    expect(refused?.reason).toBeTruthy();
    act(() => useGameStore.setState({ game }));
    render(<NodeHarness />);
    fireEvent.change(screen.getByLabelText('Node order'), {
      target: { value: refused.request.requestId },
    });
    expect(screen.getByText(refused.reason!)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Carry out order/ })).toBeDisabled();
    expect(useGameStore.getState().game!.cp).toEqual(game.cp);
  });
});
