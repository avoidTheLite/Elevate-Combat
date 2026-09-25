// Shared battle fixtures for engine mechanics tests.

import type { BattleContext } from './battleMap.ts';
import { refreshOccupancy } from './battleMap.ts';
import { buildWorld } from './grid.ts';
import { hexKey, spiral } from './hex.ts';
import type { Rng } from './rng.ts';
import { generateTerrain } from './terrain.ts';
import type { Battle, BattleUnit, Team } from './types.ts';
import { unitType } from './units.ts';

export function scriptedRng(rolls: number[]): Rng {
  let i = 0;
  return {
    next: () => 0,
    die: (sides) => {
      const raw = rolls[i] ?? sides;
      i += 1;
      // Clamp so siege-soft variance (d6) never sees an out-of-range script leftover.
      return ((raw - 1) % sides) + 1;
    },
    int: (min) => min,
    pick: (items) => items[0]!,
    state: () => i,
  };
}

export function mkUnit(
  id: string,
  typeId: string,
  team: Team,
  pos: string,
  facing = 0,
): BattleUnit {
  const t = unitType(typeId);
  return {
    id,
    typeId,
    label: id,
    team,
    hp: t.hp,
    maxHp: t.hp,
    pos,
    facing,
    mp: t.move,
    moved: false,
    movedDist: 0,
    acted: false,
    deployed: false,
    suppressed: false,
    exposed: false,
    firstStrikeUsed: false,
  };
}

/** Flat height-2 battlefield around the origin; occupancy refreshed. */
export function flatBattle(units: BattleUnit[], extras: Partial<Battle> = {}): {
  ctx: BattleContext;
  battle: Battle;
} {
  const world = buildWorld({ mainCols: 3, mainRows: 3, subRadius: 2 });
  const terrain = generateTerrain(world, 1);
  const cells = new Set(spiral({ q: 0, r: 0 }, 14).map(hexKey));
  const ctx: BattleContext = {
    world,
    terrain,
    cells,
    heightOf: (k) => (cells.has(k) ? 2 : undefined),
    unitAt: new Map(),
  };
  const battle = {
    phase: 'combat',
    active: 'A',
    attacker: 'A',
    defender: 'B',
    round: 1,
    maxRounds: 8,
    forts: {},
    log: [],
    units,
    contested: world.mains[0]!.key,
    origin: world.mains[1]?.key ?? world.mains[0]!.key,
    mains: world.mains.map((m) => m.key),
    attackerArmyId: 'att',
    defenderArmyId: 'def',
    warningTurns: 0,
    warnedPlacements: 0,
    warnedRange: 0,
    objective: {
      kind: 'capture_point',
      captureKey: hexKey(world.mains.find((m) => m.key === (extras.contested ?? world.mains[0]!.key))!.center),
      captureRadius: 1,
      extractionAtOrigin: true,
    },
    winner: null,
    endReason: null,
    extracted: false,
    ...extras,
  } as Battle;
  refreshOccupancy(ctx, battle);
  return { ctx, battle };
}
