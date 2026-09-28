// ── Axial hex math (pointy-top) ──────────────────────────────────────────────
// Reference: redblobgames hex grids. q = column axis, r = row axis, s = -q-r.

export interface Hex {
  q: number;
  r: number;
}

export type HexKey = string;

export const DIRECTIONS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export const SQRT3 = Math.sqrt(3);

export function hex(q: number, r: number): Hex {
  return { q, r };
}

export function hexKey(h: Hex): HexKey {
  return `${h.q},${h.r}`;
}

export function parseKey(key: HexKey): Hex {
  const [q, r] = key.split(',').map(Number);
  return { q: q!, r: r! };
}

export function hexAdd(a: Hex, b: Hex): Hex {
  return { q: a.q + b.q, r: a.r + b.r };
}

export function hexSub(a: Hex, b: Hex): Hex {
  return { q: a.q - b.q, r: a.r - b.r };
}

export function hexScale(a: Hex, k: number): Hex {
  return { q: a.q * k, r: a.r * k };
}

export function hexEq(a: Hex, b: Hex): boolean {
  return a.q === b.q && a.r === b.r;
}

export function hexLength(a: Hex): number {
  return (Math.abs(a.q) + Math.abs(a.r) + Math.abs(a.q + a.r)) / 2;
}

export function hexDistance(a: Hex, b: Hex): number {
  return hexLength(hexSub(a, b));
}

export function neighbor(h: Hex, dir: number): Hex {
  return hexAdd(h, DIRECTIONS[((dir % 6) + 6) % 6]!);
}

export function neighbors(h: Hex): Hex[] {
  return DIRECTIONS.map((d) => hexAdd(h, d));
}

/** Index of the direction from a to an adjacent b, or -1 if not adjacent. */
export function directionTo(a: Hex, b: Hex): number {
  const d = hexSub(b, a);
  return DIRECTIONS.findIndex((x) => x.q === d.q && x.r === d.r);
}

export function hexRound(q: number, r: number): Hex {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  // Normalise -0 so keys stay stable.
  return { q: rq + 0, r: rr + 0 };
}

/** All hexes within `radius` of `center`, center first then ring by ring. */
export function spiral(center: Hex, radius: number): Hex[] {
  const out: Hex[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const lo = Math.max(-radius, -dq - radius);
    const hi = Math.min(radius, -dq + radius);
    for (let dr = lo; dr <= hi; dr++) out.push({ q: center.q + dq, r: center.r + dr });
  }
  return out.sort((a, b) => hexDistance(a, center) - hexDistance(b, center));
}

/** Hexes on the straight line from a to b inclusive (nudged to break ties). */
export function hexLine(a: Hex, b: Hex): Hex[] {
  const n = hexDistance(a, b);
  if (n === 0) return [a];
  const out: Hex[] = [];
  const aq = a.q + 1e-6;
  const ar = a.r + 1e-6;
  const bq = b.q + 1e-6;
  const br = b.r + 1e-6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(hexRound(aq + (bq - aq) * t, ar + (br - ar) * t));
  }
  return out;
}

/** World-space centre of a hex with circumradius `size` (x right, z down/south). */
export function hexToWorld(h: Hex, size = 1): { x: number; z: number } {
  return { x: size * SQRT3 * (h.q + h.r / 2), z: size * 1.5 * h.r };
}

export function worldToHex(x: number, z: number, size = 1): Hex {
  const q = ((SQRT3 / 3) * x - (1 / 3) * z) / size;
  const r = ((2 / 3) * z) / size;
  return hexRound(q, r);
}

/** Corner i (0..5) of a pointy-top hex, relative to its centre. Corner 0 points south (+z). */
export function hexCorner(i: number, size = 1): { x: number; z: number } {
  const angle = (Math.PI / 3) * i + Math.PI / 2;
  return { x: size * Math.cos(angle), z: size * Math.sin(angle) };
}

/**
 * The two corners bounding the edge shared with neighbour `dir`.
 * Derived from the angle of each direction's world vector, so it is always consistent
 * with `hexToWorld` and `DIRECTIONS`.
 */
export function edgeCorners(
  dir: number,
  size = 1,
): [{ x: number; z: number }, { x: number; z: number }] {
  const d = hexToWorld(DIRECTIONS[dir]!, 1);
  const mid = Math.atan2(d.z, d.x);
  const a0 = mid - Math.PI / 6;
  const a1 = mid + Math.PI / 6;
  return [
    { x: size * Math.cos(a0), z: size * Math.sin(a0) },
    { x: size * Math.cos(a1), z: size * Math.sin(a1) },
  ];
}

/** Odd-r offset (col,row) → axial. Used to lay out rectangular strategic maps. */
export function offsetToAxial(col: number, row: number): Hex {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

export function axialToOffset(h: Hex): { col: number; row: number } {
  return { col: h.q + (h.r - (h.r & 1)) / 2, row: h.r };
}
