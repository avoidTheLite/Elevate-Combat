import { beforeEach, describe, expect, it } from 'vitest';
import type { GameState } from '@iron-ridge/engine';
import { commanderReach, worldOf } from '@iron-ridge/engine';
import type { UiState } from '../stores/useGameStore.ts';
import { useGameStore } from '../stores/useGameStore.ts';
import { strategicClick } from './strategicClick.ts';
import { alphaGarrison, bravoInRange, commanderOf, strategicGame } from './testGames.ts';

function load(game: GameState): void {
  useGameStore.getState().quit();
  useGameStore.setState({ game });
}

const ui = (): UiState => useGameStore.getState().ui;
const game = (): GameState => useGameStore.getState().game!;

beforeEach(() => localStorage.clear());

describe('strategic map clicks', () => {
  it('clicking a commander selects it; clicking a reachable cell moves it there', () => {
    load(strategicGame(true));
    const a = commanderOf(game(), 'A');
    strategicClick(a.pos);
    expect(ui().selectedArmy).toBe(a.id);
    const dest = [...commanderReach(game(), a).entries()].find(([, n]) => n === 2)![0];
    strategicClick(dest);
    const moved = commanderOf(game(), 'A');
    expect(moved.pos).toBe(dest);
    expect(moved.movesLeft).toBe(a.movesLeft - 2);
    expect(ui().selectedArmy).toBe(a.id); // still selected: steps remain
  });

  it('clicking an engageable enemy opens the battle-pending flow', () => {
    load(bravoInRange(strategicGame(false)));
    const a = commanderOf(game(), 'A');
    const b = commanderOf(game(), 'B');
    strategicClick(a.pos);
    strategicClick(b.pos);
    expect(game().phase).toBe('battle-pending');
    expect(game().pending).toMatchObject({ attackerArmyId: a.id, defenderArmyId: b.id });
  });

  it('clicking the HQ building selects the garrison; elsewhere selects just the hex', () => {
    load(strategicGame(true));
    const g = alphaGarrison(game());
    strategicClick(g.pos);
    expect(ui().selectedArmy).toBe(g.id);
    expect(ui().selectedMain).toBe(g.at);
    const { world } = worldOf(game());
    const far = world.mains.find((m) => m.key !== game().hq.A && m.key !== game().hq.B)!;
    strategicClick(far.subKeys[0]!);
    expect(ui().selectedMain).toBe(far.key);
    expect(ui().selectedArmy).toBeNull();
  });

  it('under fog an unseen enemy cannot be selected', () => {
    load(strategicGame(true));
    const b = commanderOf(game(), 'B');
    strategicClick(b.pos);
    expect(ui().selectedArmy).toBeNull();
    expect(ui().selectedMain).toBe(b.at);
  });
});
