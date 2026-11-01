// ── Battle-map context: the sub-hex cells of the contested main hex + neighbours ──

import type { HexKey } from './hex.ts';
import { hexDistance, hexKey, parseKey, spiral } from './hex.ts';
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
  /** Configured infrastructure road benefit; absent for Classic and isolated combat fixtures. */
  roadEdges?: ReadonlySet<string>;
  roadMultiplier?: number;
}

/** Replaces procedural terrain for battle contexts (simulator only; default off). */
export type TerrainOverride = (world: World, seed: number) => Terrain;

let terrainOverride: TerrainOverride | undefined;

/**
 * Run `fn` with battle contexts built from `override` instead of
 * `generateTerrain(world, settings.seed)`. Synchronous and nesting-safe, like
 * `withRules`. Used by the micro combat simulator for flat/slope/ridge maps.
 */
export function withTerrainOverride<T>(override: TerrainOverride | undefined, fn: () => T): T {
  const prev = terrainOverride;
  terrainOverride = override;
  try {
    return fn();
  } finally {
    terrainOverride = prev;
  }
}

export function buildContext(settings: GameSettings, battle: Battle): BattleContext {
  const world = buildWorld(settings.grid);
  const terrain = terrainOverride
    ? terrainOverride(world, settings.seed)
    : generateTerrain(world, settings.seed);
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
function primaryDeploymentZone(ctx: BattleContext, battle: Battle, team: Team): HexKey[] {
  const own = team === battle.defender ? battle.contested : battle.origin;
  const other = team === battle.defender ? battle.origin : battle.contested;
  const n = ctx.world.config.subRadius;
  const otherCentre = ctx.world.mainByKey.get(other)!.center;
  return ctx.world.mainByKey
    .get(own)!
    .subKeys.filter((k) => hexDistance(parseKey(k), otherCentre) > n + DEPLOY_BUFFER);
}

/**
 * A participating commander's deploy cells follow its recorded location, not
 * a reinforcement journey. Primary holders retain the existing deploy zones.
 * Opposing overlapping zones are divided by nearest recorded zone anchor,
 * with holder identity breaking ties, so first deployment cannot consume the
 * other side's finite deployment space.
 */
export function deploymentZone(
  ctx: BattleContext,
  battle: Battle,
  team: Team,
  holderId?: string,
): HexKey[] {
  if (!battle.participants) return primaryDeploymentZone(ctx, battle, team);
  const zones = battle.participants.map((participant) => {
    const anchor = participant.primary
      ? hexKey(
          ctx.world.mainByKey.get(
            participant.team === battle.defender ? battle.contested : battle.origin,
          )!.center,
        )
      : participant.pos;
    const cells = participant.primary
      ? primaryDeploymentZone(ctx, battle, participant.team)
      : spiral(parseKey(anchor), ctx.world.config.subRadius)
          .map(hexKey)
          .filter((key) => ctx.world.subByKey.has(key) && ctx.cells.has(key));
    return { ...participant, anchor, cells: new Set(cells) };
  });
  const allowed = new Set<string>();
  for (const zone of zones.filter(
    (candidate) => candidate.team === team && (!holderId || candidate.armyId === holderId),
  )) {
    for (const key of zone.cells) {
      const contenders = zones.filter((candidate) => candidate.cells.has(key));
      if (!contenders.some((candidate) => candidate.team !== team)) {
        allowed.add(key);
        continue;
      }
      contenders.sort(
        (a, b) =>
          hexDistance(parseKey(key), parseKey(a.anchor)) -
            hexDistance(parseKey(key), parseKey(b.anchor)) || a.armyId.localeCompare(b.armyId),
      );
      if (contenders[0]!.team === team) allowed.add(key);
    }
  }
  return [...allowed].sort();
}

export function roadEdgeKey(a: HexKey, b: HexKey): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}
