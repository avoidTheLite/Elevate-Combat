import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  apply,
  createFoundationPlaytestConfiguration,
  createGame,
  defaultSettings,
  setHolderPos,
  worldOf,
} from '@iron-ridge/engine';
import type { GameState } from '@iron-ridge/engine';
import App from './App.tsx';
import { useGameStore } from './stores/useGameStore.ts';

beforeEach(() => {
  localStorage.clear();
  act(() => useGameStore.getState().quit());
});

function turnStartCaptureFixture(): GameState {
  let game = createGame({
    ...defaultSettings(),
    controllers: { A: 'human', B: 'human' },
    fog: false,
    infrastructure: createFoundationPlaytestConfiguration(7, 3),
  });
  const bTurn = apply(game, { type: 'endTurn' });
  if (bTurn.error) throw new Error(bTurn.error);
  game = bTurn.state;
  const commander = game.armies.find(
    (holder) => holder.team === 'A' && holder.kind === 'commander',
  )!;
  const { world } = worldOf(game);
  const homeB = game.armies.find((holder) => holder.team === 'B' && holder.building === 'hq')!;
  homeB.units = [];
  for (const enemy of game.armies.filter(
    (holder) => holder.team === 'B' && holder.kind === 'commander',
  )) {
    const unoccupied = world.subs.find(
      (cell) => cell.main !== game.hq.B && !game.armies.some((holder) => holder.pos === cell.key),
    )!;
    setHolderPos(world, enemy, unoccupied.key);
  }
  const position = world.subs.find((cell) => cell.main === game.hq.B && cell.key !== homeB.pos)!;
  setHolderPos(world, commander, position.key);
  const next = apply(game, { type: 'endTurn' });
  if (next.error) throw new Error(next.error);
  if (!next.state.infrastructure?.capture.pending)
    throw new Error('Expected turn-start node choice');
  return next.state;
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001 / GAMES-ELEVATE-CAMPAIGN-UC-002: infrastructure player journeys', () => {
  it('requires explicit capture prices before starting the named playtest in the normal game', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'INFRASTRUCTURE PLAYTEST' }));
    expect(screen.getByLabelText('Capture Node price (CP)')).toHaveValue(null);
    expect(screen.getByLabelText('Raze Node price (CP)')).toHaveValue(null);
    expect(screen.getByRole('button', { name: 'START NEW GAME' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Capture Node price (CP)'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Raze Node price (CP)'), { target: { value: '7' } });
    expect(screen.getByRole('button', { name: 'START NEW GAME' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Raze Node price (CP)'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'START NEW GAME' }));
    const game = useGameStore.getState().game!;
    expect(game.settings.infrastructure?.tuningStatus).toBe('playtest');
    expect(game.settings.infrastructure?.nodes.captureCosts).toEqual({ capture: 7, raze: 3 });
    expect(game.infrastructure?.capture.nodes.length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /END TURN/ })).toBeInTheDocument();
  });

  it('saves an uncommitted Do nothing choice and resumes the exact state before committing unchanged ownership', () => {
    const game = turnStartCaptureFixture();
    act(() => useGameStore.setState({ game }));
    render(<App />);
    expect(screen.getByRole('dialog', { name: 'Campaign decision' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Do nothing .* \(0 CP\)/ }));
    const saved = structuredClone(useGameStore.getState().game!);
    const ownerBefore = saved.infrastructure!.capture.nodes.find(
      (node) => node.mainHex === saved.hq.B,
    )!.owner;
    fireEvent.click(screen.getByRole('button', { name: 'Save & Quit' }));
    expect(useGameStore.getState().game).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }));
    expect(useGameStore.getState().game).toEqual(saved);
    expect(screen.getByRole('button', { name: /Do nothing .* \(0 CP\)/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm all choices' }));
    const committed = useGameStore.getState().game!;
    expect(committed.infrastructure!.capture.pending).toBeNull();
    expect(
      committed.infrastructure!.capture.nodes.find((node) => node.mainHex === committed.hq.B)!
        .owner,
    ).toBe(ownerBefore);
    expect(committed.cp).toEqual(saved.cp);
    expect(committed.turn).toBe(saved.turn);
    expect(committed.active).toBe(saved.active);
    expect(committed.forts).toEqual(saved.forts);
    expect(committed.phase).toBe('strategic');
    expect(committed.winner).toBeNull();
  });
});
