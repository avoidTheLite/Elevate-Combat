// ── Hierarchical hex grid ────────────────────────────────────────────────────
//
// The strategic ("main") map is made of large hexes. Each main hex is a hexagonal
// cluster of small tactical ("sub") hexes of radius n (3n²+3n+1 cells).
//
// Key guarantee: there is only ONE sub-hex lattice for the whole world. Main hexes
// are defined as clusters *on* that lattice, so the sub-hexes of adjacent main hexes
// are always perfectly aligned — they are literally neighbours on the same grid.
//
// Radius-n hex clusters tile the plane using the lattice basis
//     v1 = (n+1, n)       v2 = (-n, 2n+1)          (axial sub-hex coordinates)
// with determinant 3n²+3n+1 = cluster size, so the tiling has no gaps or overlaps.
// Main-grid axial coordinates (A,B) map to the sub-hex centre A·v1 + B·v2, and the
// six main-grid directions map to the six vectors of length 2n+1 — i.e. the main
// grid is itself a proper hex grid (rotated by atan of v1 relative to the sub grid).

import type { Hex, HexKey } from './hex.ts';
import {
  DIRECTIONS,
  edgeCorners,
  hexDistance,
  hexKey,
  hexRound,
  hexToWorld,
  neighbor,
  offsetToAxial,
  spiral,
} from './hex.ts';

export interface GridConfig {
  /** Strategic map width in main hexes. */
  mainCols: number;
  /** Strategic map height in main hexes. */
  mainRows: number;
  /** Radius of each main hex measured in sub-hexes (cells per main = 3n²+3n+1). */
  subRadius: number;
}

export const GRID_LIMITS = {
  mainCols: { min: 3, max: 12 },
  mainRows: { min: 3, max: 10 },
  subRadius: { min: 2, max: 6 },
} as const;

export interface MainCell {
  key: HexKey;
  hex: Hex; // main-grid axial
  col: number;
  row: number;
  center: Hex; // sub-grid axial of the cluster centre
  subKeys: HexKey[];
}

export interface SubCell {
  key: HexKey;
  hex: Hex;
  main: HexKey;
  index: number;
}

export interface BoundaryEdge {
  /** Sub-hex on the inside of the border. */
  sub: HexKey;
  dir: number;
  /** Main hex on the other side, or null at the map edge. */
  otherMain: HexKey | null;
}

export interface World {
  config: GridConfig;
  mains: MainCell[];
  mainByKey: Map<HexKey, MainCell>;
  subs: SubCell[];
  subByKey: Map<HexKey, SubCell>;
  /** Angle (radians, world x→z) of main direction 0 — rotate by this to square up the main map. */
  mainAxisAngle: number;
}

export function clusterSize(n: number): number {
  return 3 * n * n + 3 * n + 1;
}

export function basis(n: number): { v1: Hex; v2: Hex } {
  return { v1: { q: n + 1, r: n }, v2: { q: -n, r: 2 * n + 1 } };
}

export function mainToSubCenter(main: Hex, n: number): Hex {
  const { v1, v2 } = basis(n);
  return { q: main.q * v1.q + main.r * v2.q, r: main.q * v1.r + main.r * v2.r };
}

/** Which main hex owns a given sub-hex. Pure lattice maths — valid for any sub-hex. */
export function subToMain(sub: Hex, n: number): Hex {
  const d = clusterSize(n);
  const a = ((2 * n + 1) * sub.q + n * sub.r) / d;
  const b = (-n * sub.q + (n + 1) * sub.r) / d;
  const guess = hexRound(a, b);
  const candidates = [guess, ...DIRECTIONS.map((_, i) => neighbor(guess, i))];
  for (const c of candidates) {
    if (hexDistance(mainToSubCenter(c, n), sub) <= n) return c;
  }
  // Unreachable for a valid tiling; kept as a hard failure so tests catch regressions.
  throw new Error(`subToMain: no owner for ${sub.q},${sub.r}`);
}

export function validateConfig(cfg: GridConfig): GridConfig {
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, Math.round(v)));
  return {
    mainCols: clamp(cfg.mainCols, GRID_LIMITS.mainCols.min, GRID_LIMITS.mainCols.max),
    mainRows: clamp(cfg.mainRows, GRID_LIMITS.mainRows.min, GRID_LIMITS.mainRows.max),
    subRadius: clamp(cfg.subRadius, GRID_LIMITS.subRadius.min, GRID_LIMITS.subRadius.max),
  };
}

const worldCache = new Map<string, World>();

export function buildWorld(input: GridConfig): World {
  const config = validateConfig(input);
  const cacheKey = `${config.mainCols}x${config.mainRows}x${config.subRadius}`;
  const cached = worldCache.get(cacheKey);
  if (cached) return cached;

  const n = config.subRadius;
  const mains: MainCell[] = [];
  const mainByKey = new Map<HexKey, MainCell>();
  const subs: SubCell[] = [];
  const subByKey = new Map<HexKey, SubCell>();

  for (let row = 0; row < config.mainRows; row++) {
    for (let col = 0; col < config.mainCols; col++) {
      const h = offsetToAxial(col, row);
      const center = mainToSubCenter(h, n);
      const cell: MainCell = { key: hexKey(h), hex: h, col, row, center, subKeys: [] };
      for (const s of spiral(center, n)) {
        const sc: SubCell = { key: hexKey(s), hex: s, main: cell.key, index: subs.length };
        subs.push(sc);
        subByKey.set(sc.key, sc);
        cell.subKeys.push(sc.key);
      }
      mains.push(cell);
      mainByKey.set(cell.key, cell);
    }
  }

  const v1w = hexToWorld(basis(n).v1);
  const world: World = {
    config,
    mains,
    mainByKey,
    subs,
    subByKey,
    mainAxisAngle: Math.atan2(v1w.z, v1w.x),
  };
  worldCache.set(cacheKey, world);
  return world;
}

export function mainNeighbors(world: World, mainKey: HexKey): MainCell[] {
  const m = world.mainByKey.get(mainKey);
  if (!m) return [];
  return DIRECTIONS.map((_, i) => world.mainByKey.get(hexKey(neighbor(m.hex, i)))).filter(
    (x): x is MainCell => x !== undefined,
  );
}

export function mainDistance(world: World, a: HexKey, b: HexKey): number {
  const ma = world.mainByKey.get(a);
  const mb = world.mainByKey.get(b);
  if (!ma || !mb) return Infinity;
  return hexDistance(ma.hex, mb.hex);
}

/** Edges of sub-hexes that lie on a main-hex border (for drawing the strategic grid). */
export function mainBoundary(world: World, mainKey: HexKey): BoundaryEdge[] {
  const m = world.mainByKey.get(mainKey);
  if (!m) return [];
  const out: BoundaryEdge[] = [];
  for (const sk of m.subKeys) {
    const s = world.subByKey.get(sk)!;
    for (let dir = 0; dir < 6; dir++) {
      const nk = hexKey(neighbor(s.hex, dir));
      const ns = world.subByKey.get(nk);
      if (ns && ns.main === mainKey) continue;
      out.push({ sub: sk, dir, otherMain: ns ? ns.main : null });
    }
  }
  return out;
}

/** World-space line segment for a boundary edge. */
export function edgeSegment(
  world: World,
  edge: BoundaryEdge,
  size = 1,
): { a: { x: number; z: number }; b: { x: number; z: number } } {
  const s = world.subByKey.get(edge.sub)!;
  const c = hexToWorld(s.hex, size);
  const [p0, p1] = edgeCorners(edge.dir, size);
  return { a: { x: c.x + p0.x, z: c.z + p0.z }, b: { x: c.x + p1.x, z: c.z + p1.z } };
}
