// ── Line of sight & arc clearance ────────────────────────────────────────────
// Ray-march along the hex line between shooter and target. The sight line runs
// from shooter eye height to target body height; any intermediate hex whose
// terrain top rises above the line blocks it. Clearance < MARGIN = "marginal"
// (amber in the firing view).

import type { Hex } from './hex.ts';
import { hexDistance, hexKey, hexLine } from './hex.ts';

export type LosStatus = 'clear' | 'marginal' | 'blocked';

export interface LosResult {
  status: LosStatus;
  /** Smallest (line height − terrain) along the path. */
  clearance: number;
  blockedAt: Hex | null;
  path: Hex[];
}

export const LOS_MARGIN = 0.5;
export const TARGET_BODY = 0.5;

export type HeightFn = (key: string) => number | undefined;

export function lineOfSight(
  from: Hex,
  to: Hex,
  heightOf: HeightFn,
  eye = 0.5,
  body = TARGET_BODY,
): LosResult {
  const path = hexLine(from, to);
  const h0 = (heightOf(hexKey(from)) ?? 0) + eye;
  const h1 = (heightOf(hexKey(to)) ?? 0) + body;
  let clearance = Infinity;
  let blockedAt: Hex | null = null;
  for (let i = 1; i < path.length - 1; i++) {
    const t = i / (path.length - 1);
    const line = h0 + (h1 - h0) * t;
    const ground = heightOf(hexKey(path[i]!));
    // Off-map / outside the battle footprint: fail closed so edge fights can't clip void.
    if (ground === undefined) {
      if (!blockedAt) blockedAt = path[i]!;
      clearance = Math.min(clearance, -1);
      continue;
    }
    const c = line - ground;
    if (c < clearance) clearance = c;
    if (c < 0 && !blockedAt) blockedAt = path[i]!;
  }
  if (clearance === Infinity) clearance = 99;
  const status: LosStatus = blockedAt ? 'blocked' : clearance < LOS_MARGIN ? 'marginal' : 'clear';
  return { status, clearance, blockedAt, path };
}

/** Apex height of a lobbed arc above the straight line, by horizontal distance. */
export function arcApex(distance: number): number {
  return 1.2 + distance * 0.55;
}

/** Height of an indirect-fire arc at fraction t of the flight. */
export function arcHeight(h0: number, h1: number, distance: number, t: number): number {
  return h0 + (h1 - h0) * t + 4 * arcApex(distance) * t * (1 - t);
}

/** Indirect fire: does the ballistic arc clear the terrain? */
export function arcClearance(from: Hex, to: Hex, heightOf: HeightFn, eye = 0.5): LosResult {
  const path = hexLine(from, to);
  const dist = hexDistance(from, to);
  const h0 = (heightOf(hexKey(from)) ?? 0) + eye;
  const h1 = (heightOf(hexKey(to)) ?? 0) + TARGET_BODY;
  let clearance = Infinity;
  let blockedAt: Hex | null = null;
  for (let i = 1; i < path.length - 1; i++) {
    const t = i / (path.length - 1);
    const line = arcHeight(h0, h1, dist, t);
    const ground = heightOf(hexKey(path[i]!));
    if (ground === undefined) {
      if (!blockedAt) blockedAt = path[i]!;
      clearance = Math.min(clearance, -1);
      continue;
    }
    const c = line - ground;
    if (c < clearance) clearance = c;
    if (c < 0 && !blockedAt) blockedAt = path[i]!;
  }
  if (clearance === Infinity) clearance = 99;
  const status: LosStatus = blockedAt ? 'blocked' : clearance < LOS_MARGIN ? 'marginal' : 'clear';
  return { status, clearance, blockedAt, path };
}
