// ── Battle-map context: the sub-hex cells of the contested main hex + neighbours ──

import type { HexKey } from './hex.ts';
import { hexDistance, parseKey } from './hex.ts';
import type { World } from './grid.ts';
import { buildWorld } from './grid.ts';
import type { Terrain } from './terrain.ts';
import { generateTerrain } from './terrain.ts';
import type { Battle, BattleUnit, GameSettings, Team } from './types.ts';
import type { HeightFn } from './los.ts';

export interface BattleContext {
  world: World;
  terrain: Terrain;
  cells: Set<HexKey>;
  heightOf: HeightFn;
  unitAt: Map<HexKey, BattleUnit>;
}

export function buildContext(settings: GameSettings, battle: Battle): BattleContext {
  const world = buildWorld(settings.grid);
  const terrain = generateTerrain(world, settings.seed);
  const cells = new Set<HexKey>();
  for (const mk of battle.mains) for (const sk of world.mainByKey.get(mk)!.subKeys) cells.add(sk);
  const heightOf: HeightFn = (key) => {
    const s = world.subByKey.get(key);
    return s ? terrain.heights[s.index] : undefined;
  };
  const unitAt = new Map<HexKey, BattleUnit>();
  for (const u of battle.units) if (u.pos && u.hp > 0) unitAt.set(u.pos, u);
  return { world, terrain, cells, heightOf, unitAt };
}

export function refreshOccupancy(ctx: BattleContext, battle: Battle): void {
  ctx.unitAt.clear();
  for (const u of battle.units) if (u.pos && u.hp > 0) ctx.unitAt.set(u.pos, u);
}

export function h(ctx: BattleContext, key: HexKey): number {
  return ctx.heightOf(key) ?? 0;
}

export function liveUnits(battle: Battle, team?: Team): BattleUnit[] {
  return battle.units.filter((u) => u.hp > 0 && u.pos !== null && (!team || u.team === team));
}

/** Cells within this many steps of the opposing zone's main hex are off-limits at deployment. */
export const DEPLOY_BUFFER = 2;

/**
 * Cells a team may deploy into: its own main hex (defender → contested, attacker →
 * origin), minus a no-man's-land strip along the shared border so battles open
 * with a gap to close rather than point-blank.
 */
export function deploymentZone(ctx: BattleContext, battle: Battle, team: Team): HexKey[] {
  const own = team === battle.defender ? battle.contested : battle.origin;
  const other = team === battle.defender ? battle.origin : battle.contested;
  const n = ctx.world.config.subRadius;
  const otherCentre = ctx.world.mainByKey.get(other)!.center;
  return ctx.world.mainByKey
    .get(own)!
    .subKeys.filter((k) => hexDistance(parseKey(k), otherCentre) > n + DEPLOY_BUFFER);
}
