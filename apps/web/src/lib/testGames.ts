// Test fixtures: small strategic games for the command-layer UI tests.

import type { Army, GameState, HexKey } from '@iron-ridge/engine';
import {
  COMMAND,
  apply,
  createGame,
  defaultSettings,
  garrisonOf,
  hexDistance,
  occupiedSubs,
  setHolderPos,
  worldOf,
} from '@iron-ridge/engine';

export function strategicGame(fog = true): GameState {
  return createGame({
    ...defaultSettings(),
    grid: { mainCols: 5, mainRows: 3, subRadius: 3 },
    controllers: { A: 'human', B: 'ai' },
    fog,
  });
}

export function commanderOf(game: GameState, team: 'A' | 'B'): Army {
  return game.armies.find((a) => a.team === team && a.kind === 'commander')!;
}

/** Recruit `n` of the era's first unit type into Alpha's HQ garrison. */
export function withRecruits(game: GameState, n: number): GameState {
  let s = game;
  s.cp.A = 999;
  for (let i = 0; i < n; i++) {
    const r = apply(s, { type: 'recruit', typeId: 'ww2_rifle_infantry' });
    if (r.error) throw new Error(r.error);
    s = r.state;
  }
  return s;
}

export function alphaGarrison(game: GameState): Army {
  return garrisonOf(game, 'A')!;
}

/** Put Bravo's commander on a free cell within engage range of Alpha's commander. */
export function bravoInRange(game: GameState): GameState {
  const s = structuredClone(game);
  const { world } = worldOf(s);
  const a = commanderOf(s, 'A');
  const b = commanderOf(s, 'B');
  const from = world.subByKey.get(a.pos)!.hex;
  const taken = occupiedSubs(s, b.id);
  const range = COMMAND.engageRange(world.config.subRadius);
  const cell: HexKey = world.subs.find(
    (x) =>
      !taken.has(x.key) &&
      x.main !== s.hq.A &&
      hexDistance(x.hex, from) >= 2 &&
      hexDistance(x.hex, from) <= range,
  )!.key;
  setHolderPos(world, b, cell);
  return s;
}
