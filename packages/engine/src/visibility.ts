// ── Fog of war / spotting ────────────────────────────────────────────────────
// A team sees a cell if any of its units is within vision range and has LOS.
// High ground extends the *viewer's* vision (+1 per 3 levels) as a one-way FOW
// advantage — elevated units are not automatically more exposed.

import type { HexKey } from './hex.ts';
import { hexDistance, parseKey, spiral, hexKey } from './hex.ts';
import type { BattleContext } from './battleMap.ts';
import { h, liveUnits } from './battleMap.ts';
import { lineOfSight } from './los.ts';
import type { Battle, BattleUnit, Team } from './types.ts';
import { unitType } from './units.ts';

export function visionRange(ctx: BattleContext, u: BattleUnit): number {
  if (!u.pos) return 0;
  return unitType(u.typeId).vision + Math.floor(h(ctx, u.pos) / 3);
}

export function canSee(ctx: BattleContext, viewer: BattleUnit, target: HexKey): boolean {
  if (!viewer.pos) return false;
  const a = parseKey(viewer.pos);
  const b = parseKey(target);
  if (hexDistance(a, b) > visionRange(ctx, viewer)) return false;
  if (viewer.pos === target) return true;
  const los = lineOfSight(a, b, ctx.heightOf, unitType(viewer.typeId).eye);
  return los.status !== 'blocked';
}

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

export function visibleEnemies(ctx: BattleContext, battle: Battle, team: Team): BattleUnit[] {
  const cells = visibleCells(ctx, battle, team);
  return liveUnits(battle).filter((u) => u.team !== team && (cells.has(u.pos!) || u.revealed));
}

/** Is `target` spotted for indirect fire by any friendly unit (including the shooter)? */
export function isSpotted(ctx: BattleContext, battle: Battle, team: Team, target: HexKey): boolean {
  if (liveUnits(battle, team).some((u) => canSee(ctx, u, target))) return true;
  // A unit that just fired stays revealed — that revelation also spots its hex for HE.
  return liveUnits(battle).some(
    (u) => u.team !== team && u.revealed && u.pos === target && u.hp > 0,
  );
}
