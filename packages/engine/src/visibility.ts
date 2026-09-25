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

/** Cells this team can see via LOS from any live unit. */
export function visibleCells(ctx: BattleContext, battle: Battle, team: Team): Set<HexKey> {
  const out = new Set<HexKey>();
  for (const u of liveUnits(battle, team)) {
    const origin = parseKey(u.pos!);
    const eye = unitType(u.typeId).eye;
    for (const c of spiral(origin, visionRange(ctx, u))) {
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
