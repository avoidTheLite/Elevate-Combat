// ── Tactical movement: terrain-cost Dijkstra over the battle map ─────────────
// Cost per step = 1 + uphill climb (levels). Climbs above the unit's maxClimb are
// impassable (vehicles are funnelled through defiles). Height 0 is marsh (+1).
// Units may pass through friendlies but not end on them; enemies block.

import type { HexKey } from './hex.ts';
import { hexKey, neighbor, parseKey } from './hex.ts';
import type { BattleContext } from './battleMap.ts';
import { h } from './battleMap.ts';
import type { BattleUnit } from './types.ts';
import { unitType } from './units.ts';

export interface ReachNode {
  cost: number;
  prev: HexKey | null;
}

export const MAX_DROP = 4;

export function stepCost(
  ctx: BattleContext,
  from: HexKey,
  to: HexKey,
  maxClimb: number,
): number | null {
  if (!ctx.cells.has(to)) return null;
  const h0 = h(ctx, from);
  const h1 = h(ctx, to);
  const climb = h1 - h0;
  if (climb > maxClimb) return null;
  if (-climb > MAX_DROP) return null;
  return 1 + Math.max(0, climb) + (h1 === 0 ? 1 : 0);
}

export function reachable(
  ctx: BattleContext,
  unit: BattleUnit,
  mp = unit.mp,
): Map<HexKey, ReachNode> {
  const out = new Map<HexKey, ReachNode>();
  if (!unit.pos) return out;
  const t = unitType(unit.typeId);
  out.set(unit.pos, { cost: 0, prev: null });
  const frontier: { key: HexKey; cost: number }[] = [{ key: unit.pos, cost: 0 }];
  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift()!;
    if (cur.cost > (out.get(cur.key)?.cost ?? Infinity)) continue;
    const ch = parseKey(cur.key);
    for (let d = 0; d < 6; d++) {
      const nk = hexKey(neighbor(ch, d));
      const sc = stepCost(ctx, cur.key, nk, t.maxClimb);
      if (sc === null) continue;
      const occ = ctx.unitAt.get(nk);
      if (occ && occ.team !== unit.team) continue;
      const nc = cur.cost + sc;
      if (nc > mp) continue;
      if (nc < (out.get(nk)?.cost ?? Infinity)) {
        out.set(nk, { cost: nc, prev: cur.key });
        frontier.push({ key: nk, cost: nc });
      }
    }
  }
  // Can't end on a friendly unit.
  for (const k of [...out.keys()]) {
    const occ = ctx.unitAt.get(k);
    if (occ && occ.id !== unit.id) out.delete(k);
  }
  return out;
}

export function pathTo(reach: Map<HexKey, ReachNode>, dest: HexKey): HexKey[] {
  const path: HexKey[] = [];
  let cur: HexKey | null = dest;
  const guard = new Set<HexKey>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    path.unshift(cur);
    cur = reach.get(cur)?.prev ?? null;
  }
  return path;
}

/** Terrain-cost distance ignoring MP limits (for AI and warned-placement range). */
export function costField(
  ctx: BattleContext,
  sources: HexKey[],
  maxClimb: number,
  limit = Infinity,
): Map<HexKey, number> {
  const dist = new Map<HexKey, number>();
  const frontier: { key: HexKey; cost: number }[] = [];
  for (const s of sources) {
    dist.set(s, 0);
    frontier.push({ key: s, cost: 0 });
  }
  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift()!;
    if (cur.cost > (dist.get(cur.key) ?? Infinity)) continue;
    const ch = parseKey(cur.key);
    for (let d = 0; d < 6; d++) {
      const nk = hexKey(neighbor(ch, d));
      const sc = stepCost(ctx, cur.key, nk, maxClimb);
      if (sc === null) continue;
      const nc = cur.cost + sc;
      if (nc > limit) continue;
      if (nc < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nc);
        frontier.push({ key: nk, cost: nc });
      }
    }
  }
  return dist;
}
