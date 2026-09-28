// ── Battle container: a game-agnostic ruleset interface + the Iron Ridge one ──
// The container sizes a grid, builds terrain, creates a battle and steps the
// AI until it is over. Iron Ridge plugs in its *real* tactical engine and
// tactical AI unchanged (apply + tacticalAiStep), so balance results reflect
// the shipped rules.

import type { Army, ArmyUnit, BattleUnit, GameSettings, GameState, Team } from '../types.ts';
import type { GridConfig, MainCell, World } from '../grid.ts';
import { GRID_LIMITS, buildWorld, mainNeighbors } from '../grid.ts';
import type { HexKey } from '../hex.ts';
import { hexDistance, hexKey, hexToWorld, parseKey } from '../hex.ts';
import type { BattleContext } from '../battleMap.ts';
import { deploymentZone, liveUnits, withTerrainOverride } from '../battleMap.ts';
import type { Terrain } from '../terrain.ts';
import { MAX_HEIGHT, generateTerrain } from '../terrain.ts';
import type { GameAction } from '../actions.ts';
import { apply } from '../actions.ts';
import { tacticalAiStep } from '../ai/tacticalAi.ts';
import { createGame, defaultSettings } from '../strategic.ts';
import { contextFor, createBattle } from '../tactical.ts';
import { withRules } from '../rules.ts';
import { unitType } from '../units.ts';
import type { BattleSpec, SimSide, SimTerrainKind } from './spec.ts';
import { DEFAULT_MAX_ROUNDS, specUnitCount } from './spec.ts';

export interface BattleResult {
  winner: SimSide | null;
  rounds: number;
  endReason: string;
  survivors: Record<SimSide, number>;
  hpLeft: Record<SimSide, number>;
}

/**
 * What a game supplies to run inside the battle container. `State` is the
 * game's own battle state; the container only drives it through this interface.
 */
export interface BattleRuleset<Spec, State, Result> {
  id: string;
  /** Smallest grid that fits the spec (deterministic). */
  sizeGrid(spec: Spec): GridSizing;
  buildTerrain(world: World, spec: Spec, seed: number): Terrain;
  createBattle(spec: Spec, grid: GridConfig, seed: number): State;
  /** Advance by one AI action. */
  step(state: State): State;
  isOver(state: State): boolean;
  result(state: State): Result;
}

export interface GridSizing {
  grid: GridConfig;
  /** False when even the largest legal grid cannot satisfy the spec. */
  fits: boolean;
  /** Deployment cells available per side. */
  zoneCells: Record<SimSide, number>;
  /** Longest weapon range among the spec's units. */
  maxRange: number;
  /** Largest hex distance across the battle footprint (target + neighbours). */
  span: number;
}

// ── Battle site: which main hexes are fought over ──

export interface BattleSite {
  /** Contested (defender) main hex — the one with the most neighbours. */
  target: MainCell;
  /** Attacker's main hex — the west-most neighbour of the target. */
  origin: MainCell;
  /** Target + neighbours: the battle footprint. */
  mains: MainCell[];
}

const siteCache = new Map<World, BattleSite>();

export function battleSite(world: World): BattleSite {
  const hit = siteCache.get(world);
  if (hit) return hit;
  let target = world.mains[0]!;
  let best = -1;
  for (const m of world.mains) {
    const n = mainNeighbors(world, m.key).length;
    if (n > best) {
      best = n;
      target = m;
    }
  }
  const nbrs = mainNeighbors(world, target.key);
  const origin = [...nbrs].sort((a, b) => a.col - b.col || a.row - b.row)[0]!;
  const site = { target, origin, mains: [target, ...nbrs] };
  siteCache.set(world, site);
  return site;
}

/** The sim always uses the minimum strategic map; only the sub-radius grows. */
const SIM_MAIN = { mainCols: GRID_LIMITS.mainCols.min, mainRows: GRID_LIMITS.mainRows.min };

function zoneCapacity(world: World): Record<SimSide, number> {
  const site = battleSite(world);
  const ctx = { world } as BattleContext;
  const b = {
    attacker: 'A',
    defender: 'B',
    contested: site.target.key,
    origin: site.origin.key,
  } as Parameters<typeof deploymentZone>[1];
  return {
    attacker: deploymentZone(ctx, b, 'A').length,
    defender: deploymentZone(ctx, b, 'B').length,
  };
}

function footprintSpan(world: World): number {
  const site = battleSite(world);
  // Farthest pair of cells: extremes are on the footprint rim, so checking the
  // cells of the outer mains against each other is enough.
  const cells = site.mains.flatMap((m) => m.subKeys.map(parseKey));
  let span = 0;
  for (let i = 0; i < cells.length; i++)
    for (let j = i + 1; j < cells.length; j++)
      span = Math.max(span, hexDistance(cells[i]!, cells[j]!));
  return span;
}

const spanCache = new Map<number, number>();

/**
 * Grid build step: the smallest legal GridConfig (3×3 mains, growing the
 * sub-radius from its minimum) where both forces fit their deployment zones and
 * the longest weapon range in the spec fits across the battle footprint.
 * If nothing fits, returns the largest grid with `fits: false`.
 */
export function sizeBattleGrid(spec: BattleSpec): GridSizing {
  const need: Record<SimSide, number> = {
    attacker: specUnitCount(spec.attacker),
    defender: specUnitCount(spec.defender),
  };
  const maxRange = withRules(spec.rules, () =>
    Math.max(
      0,
      ...[...spec.attacker.units, ...spec.defender.units].map((u) => unitType(u.typeId).maxRange),
    ),
  );
  let last: GridSizing | null = null;
  for (let n = GRID_LIMITS.subRadius.min; n <= GRID_LIMITS.subRadius.max; n++) {
    const grid: GridConfig = { ...SIM_MAIN, subRadius: n };
    const world = buildWorld(grid);
    const zoneCells = zoneCapacity(world);
    let span = spanCache.get(n);
    if (span === undefined) {
      span = footprintSpan(world);
      spanCache.set(n, span);
    }
    const fits =
      zoneCells.attacker >= need.attacker &&
      zoneCells.defender >= need.defender &&
      span >= maxRange;
    last = { grid, fits, zoneCells, maxRange, span };
    if (fits) return last;
  }
  return last!;
}

// ── Synthetic terrain for the sim ──

const simTerrainCache = new Map<string, Terrain>();

/**
 * Deterministic flat / slope / ridge height maps over the whole world, oriented
 * along the origin → target axis (t = 0 at the origin centre, 1 at the target).
 */
export function simTerrain(world: World, kind: Exclude<SimTerrainKind, 'seeded'>): Terrain {
  const { mainCols, mainRows, subRadius } = world.config;
  const key = `${mainCols}x${mainRows}x${subRadius}:${kind}`;
  const hit = simTerrainCache.get(key);
  if (hit) return hit;
  const site = battleSite(world);
  const o = hexToWorld(site.origin.center);
  const t1 = hexToWorld(site.target.center);
  const ax = t1.x - o.x;
  const az = t1.z - o.z;
  const len2 = ax * ax + az * az || 1;
  const heights = new Int8Array(world.subs.length);
  for (const s of world.subs) {
    const p = hexToWorld(s.hex);
    const t = ((p.x - o.x) * ax + (p.z - o.z) * az) / len2;
    let hgt = 2;
    if (kind === 'slope') hgt = 2 + 2.5 * t;
    else if (kind === 'ridge') hgt = 2 + 4 * (1 - Math.abs(t - 1));
    heights[s.index] = Math.max(1, Math.min(MAX_HEIGHT, Math.round(hgt)));
  }
  const mainHeight = new Map<string, number>();
  for (const m of world.mains) {
    let sum = 0;
    for (const k of m.subKeys) sum += heights[world.subByKey.get(k)!.index]!;
    mainHeight.set(m.key, sum / m.subKeys.length);
  }
  const terrain: Terrain = { heights, mainHeight, passes: [] };
  simTerrainCache.set(key, terrain);
  return terrain;
}

// ── Iron Ridge ruleset ──

/** Extra settings the sim stores on its GameState (kept through structuredClone). */
interface SimSettings extends GameSettings {
  simTerrain?: Exclude<SimTerrainKind, 'seeded'>;
}

function terrainOverrideFor(state: GameState): ((world: World) => Terrain) | undefined {
  const kind = (state.settings as SimSettings).simTerrain;
  return kind ? (world) => simTerrain(world, kind) : undefined;
}

/** Run `fn` under the state's rules and sim terrain (what every sim step needs). */
export function inSimScope<T>(state: GameState, fn: () => T): T {
  return withRules(state.settings.rules, () => withTerrainOverride(terrainOverrideFor(state), fn));
}

const TEAM: Record<SimSide, Team> = { attacker: 'A', defender: 'B' };

function simArmy(world: World, spec: BattleSpec, side: SimSide, at: HexKey): Army {
  const team = TEAM[side];
  const units: ArmyUnit[] = [];
  let i = 0;
  for (const su of spec[side].units) {
    const t = unitType(su.typeId);
    for (let c = 0; c < su.count; c++) {
      i += 1;
      units.push({
        id: `${team}s${i}`,
        typeId: su.typeId,
        label: `${t.short}-${team}${i}`,
        hp: Math.max(1, Math.min(t.hp, su.hp ?? t.hp)),
      });
    }
  }
  // Holder position is the main-hex centre; the tactical battle only reads `at`.
  const c = world.mainByKey.get(at)!.center;
  return {
    id: `${team}army-sim`,
    kind: 'commander',
    team,
    at,
    pos: hexKey(c),
    units,
    movesLeft: 0,
  };
}

function fortify(state: GameState, spec: BattleSpec): void {
  const f = spec.forts;
  const battle = state.battle!;
  if (!f || f.level <= 0) return;
  const ctx = contextFor(state);
  const centre = ctx.world.mainByKey.get(battle.contested)!.center;
  const zone = deploymentZone(ctx, battle, battle.defender).sort(
    (a, b) =>
      hexDistance(parseKey(a), centre) - hexDistance(parseKey(b), centre) || (a < b ? -1 : 1),
  );
  const n = f.cells === undefined || f.cells === 'defender_zone' ? zone.length : f.cells;
  for (const k of zone.slice(0, n)) battle.forts[k] = f.level;
}

/** Mix a user seed into a well-spread 32-bit RNG state. */
function seedState(seed: number): number {
  let x = (seed ^ 0x2545f491) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

export const ironRidgeRuleset: BattleRuleset<BattleSpec, GameState, BattleResult> = {
  id: 'iron-ridge',

  sizeGrid: sizeBattleGrid,

  buildTerrain(world, spec, seed) {
    const kind = spec.terrain?.kind ?? 'flat';
    if (kind === 'seeded') return generateTerrain(world, spec.terrain?.seed ?? seed);
    return simTerrain(world, kind);
  },

  createBattle(spec, grid, seed) {
    const kind = spec.terrain?.kind ?? 'flat';
    const settings: SimSettings = {
      ...defaultSettings(),
      era: spec.era,
      grid,
      seed: kind === 'seeded' ? (spec.terrain?.seed ?? seed) : seed,
      controllers: { A: 'ai', B: 'ai' },
      fog: true,
      battleRounds: spec.maxRounds ?? DEFAULT_MAX_ROUNDS,
      ...(spec.rules ? { rules: spec.rules } : {}),
      ...(kind !== 'seeded' ? { simTerrain: kind } : {}),
    };
    const state = createGame(settings);
    return inSimScope(state, () => {
      const world = buildWorld(state.settings.grid);
      const site = battleSite(world);
      const att = simArmy(world, spec, 'attacker', site.origin.key);
      const def = simArmy(world, spec, 'defender', site.target.key);
      state.armies = [att, def];
      state.forts = {};
      for (const k of Object.keys(state.hexes)) state.hexes[k]!.warning = 0;
      state.pending = null;
      state.battle = createBattle(state, att, def, site.origin.key, site.target.key, world);
      state.phase = 'battle';
      state.active = 'A';
      state.rng = seedState(seed);
      fortify(state, spec);
      return state;
    });
  },

  step(state) {
    return inSimScope(state, () => {
      const action = tacticalAiStep(state);
      const res = apply(state, action);
      if (!res.error) return res.state;
      // Same fallback as runner.ts: never let an illegal AI move stall the sim.
      const b = state.battle!;
      const fb: GameAction =
        b.phase === 'deploy' ? { type: 'finishDeploy' } : { type: 'endBattleTurn' };
      const r2 = apply(state, fb);
      if (r2.error) throw new Error(`Sim stalled: ${res.error} / ${r2.error}`);
      return r2.state;
    });
  },

  isOver(state) {
    return !state.battle || state.battle.phase === 'over';
  },

  result(state) {
    const b = state.battle!;
    const side = (t: Team | null): SimSide | null =>
      t === null ? null : t === b.attacker ? 'attacker' : 'defender';
    const live = (t: Team): BattleUnit[] => liveUnits(b, t);
    const hp = (t: Team): number => live(t).reduce((s, u) => s + u.hp, 0);
    return {
      winner: b.phase === 'over' ? side(b.winner) : null,
      rounds: b.round,
      endReason: b.phase === 'over' ? (b.endReason ?? 'over') : 'step limit',
      survivors: { attacker: live(b.attacker).length, defender: live(b.defender).length },
      hpLeft: { attacker: hp(b.attacker), defender: hp(b.defender) },
    };
  },
};
