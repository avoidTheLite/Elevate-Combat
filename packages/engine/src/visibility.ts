// ── Fog of war / spotting ────────────────────────────────────────────────────
// Naming convention (player-facing vs LOS-specific):
//
//   visible*  — line-of-sight detection from a viewer/unit (tiles a unit can see)
//   revealed* — the opposing *player* knows about a unit/hex by any means
//               (LOS vision, fire exposure, future sensors, etc.)
//
// High ground extends the *viewer's* vision (+1 per 3 levels) as a one-way FOW
// advantage — elevated units are not automatically more exposed.

import type { HexKey } from './hex.ts';
import { hexDistance, parseKey, spiral, hexKey } from './hex.ts';
import type { BattleContext } from './battleMap.ts';
import { h, liveUnits } from './battleMap.ts';
import { lineOfSight } from './los.ts';
import type { Battle, BattleUnit, Team } from './types.ts';
import { unitType } from './units.ts';

/** LOS vision range for a unit (base vision + viewer-height bonus). */
export function visionRange(ctx: BattleContext, u: BattleUnit): number {
  if (!u.pos) return 0;
  return unitType(u.typeId).vision + Math.floor(h(ctx, u.pos) / 3);
}

/** Can this viewer unit see `target` via LOS + vision range? (visible / LOS path) */
export function canSee(ctx: BattleContext, viewer: BattleUnit, target: HexKey): boolean {
  if (!viewer.pos) return false;
  const a = parseKey(viewer.pos);
  const b = parseKey(target);
  if (hexDistance(a, b) > visionRange(ctx, viewer)) return false;
  if (viewer.pos === target) return true;
  const los = lineOfSight(a, b, ctx.heightOf, unitType(viewer.typeId).eye);
  return los.status !== 'blocked';
}

// Per-viewer vision memo, only active inside `withVisionCache` (the tactical AI
// evaluates thousands of hypothetical positions per decision). Within one scope
// the terrain and battle cells are fixed, so a viewer's visible cells depend only
// on (position, vision range, eye height). Results are identical to the uncached
// path, including Set insertion order.
let visionMemo: WeakMap<BattleContext, Map<string, HexKey[]>> | null = null;

/** Run `fn` with vision memoised per viewer position. Synchronous, nesting-safe. */
export function withVisionCache<T>(fn: () => T): T {
  if (visionMemo) return fn();
  visionMemo = new WeakMap();
  try {
    return fn();
  } finally {
    visionMemo = null;
  }
}

function viewerCells(ctx: BattleContext, pos: HexKey, range: number, eye: number): HexKey[] {
  const origin = parseKey(pos);
  const out: HexKey[] = [];
  for (const c of spiral(origin, range)) {
    const k = hexKey(c);
    if (!ctx.cells.has(k)) continue;
    if (k === pos || lineOfSight(origin, c, ctx.heightOf, eye).status !== 'blocked') out.push(k);
  }
  return out;
}

/** Cells this team can see via LOS from any live unit. */
export function visibleCells(ctx: BattleContext, battle: Battle, team: Team): Set<HexKey> {
  const out = new Set<HexKey>();
  let memo: Map<string, HexKey[]> | undefined;
  if (visionMemo) {
    memo = visionMemo.get(ctx);
    if (!memo) {
      memo = new Map();
      visionMemo.set(ctx, memo);
    }
  }
  for (const u of liveUnits(battle, team)) {
    const eye = unitType(u.typeId).eye;
    const range = visionRange(ctx, u);
    if (memo) {
      const key = `${u.pos}|${range}|${eye}`;
      let cells = memo.get(key);
      if (!cells) {
        cells = viewerCells(ctx, u.pos!, range, eye);
        memo.set(key, cells);
      }
      for (const k of cells) out.add(k);
      continue;
    }
    const origin = parseKey(u.pos!);
    for (const c of spiral(origin, range)) {
      const k = hexKey(c);
      if (!ctx.cells.has(k) || out.has(k)) continue;
      if (k === u.pos || lineOfSight(origin, c, ctx.heightOf, eye).status !== 'blocked') out.add(k);
    }
  }
  return out;
}

/**
 * Enemies the player/team currently knows about (revealed by any means):
 * in a visible (LOS) cell, or fire-exposed (`exposed`) even outside vision.
 */
export function revealedEnemies(ctx: BattleContext, battle: Battle, team: Team): BattleUnit[] {
  const cells = visibleCells(ctx, battle, team);
  return liveUnits(battle).filter((u) => u.team !== team && (cells.has(u.pos!) || u.exposed));
}

/** @deprecated Use {@link revealedEnemies}. */
export const visibleEnemies = revealedEnemies;

/** Is `target` revealed for indirect fire / hex targeting by this team? */
export function isHexRevealed(
  ctx: BattleContext,
  battle: Battle,
  team: Team,
  target: HexKey,
): boolean {
  if (liveUnits(battle, team).some((u) => canSee(ctx, u, target))) return true;
  // A unit that just fired stays exposed — that also reveals its hex for HE.
  return liveUnits(battle).some(
    (u) => u.team !== team && u.exposed && u.pos === target && u.hp > 0,
  );
}

/** @deprecated Use {@link isHexRevealed}. */
export const isSpotted = isHexRevealed;

/** True when this specific enemy unit is currently revealed to `team`. */
export function isUnitRevealed(
  ctx: BattleContext,
  battle: Battle,
  team: Team,
  unit: BattleUnit,
): boolean {
  if (unit.team === team || !unit.pos || unit.hp <= 0) return false;
  return revealedEnemies(ctx, battle, team).some((u) => u.id === unit.id);
}
