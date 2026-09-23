// ── Procedural height map ────────────────────────────────────────────────────
// Heights are a single continuous function of sub-hex world position, so terrain
// is seamless across main-hex borders. Values are discrete integers 0–8 per the
// core-mechanics doc (HM[row][col] → int, Map-01 range 0–8).
//
// Shape mirrors Map-01 "The Defile": plateaus on each flank, a central north–south
// ridge (H 6–8) cut by low defiles (H 2), plus fbm noise for local hills.

import { createRng } from './rng.ts';
import { hexToWorld } from './hex.ts';
import type { World } from './grid.ts';

export const MAX_HEIGHT = 8;

export interface Terrain {
  /** Height per sub-cell, indexed by SubCell.index. */
  heights: Int8Array;
  /** Mean height per main hex. */
  mainHeight: Map<string, number>;
  /** Named features for the HUD. */
  passes: number[];
}

function valueNoise2D(seed: number): (x: number, y: number) => number {
  const rng = createRng(seed);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    vals[i] = rng.next();
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i]!;
  const lattice = (ix: number, iy: number): number => vals[perm[(perm[ix & 255]! + iy) & 511]!]!;
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = smooth(x - ix);
    const fy = smooth(y - iy);
    const a = lattice(ix, iy);
    const b = lattice(ix + 1, iy);
    const c = lattice(ix, iy + 1);
    const d = lattice(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm; // 0..1
}

const terrainCache = new Map<string, Terrain>();

export function generateTerrain(world: World, seed: number): Terrain {
  const { mainCols, mainRows, subRadius } = world.config;
  const cacheKey = `${mainCols}x${mainRows}x${subRadius}:${seed}`;
  const cached = terrainCache.get(cacheKey);
  if (cached) return cached;

  const noise = valueNoise2D(seed);
  const rng = createRng(seed ^ 0x9e3779b9);

  // Work in the "main-aligned" frame: u runs west→east across the strategic map.
  const cos = Math.cos(-world.mainAxisAngle);
  const sin = Math.sin(-world.mainAxisAngle);
  const pts = world.subs.map((s) => {
    const w = hexToWorld(s.hex);
    return { u: w.x * cos - w.z * sin, v: w.x * sin + w.z * cos };
  });
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of pts) {
    uMin = Math.min(uMin, p.u);
    uMax = Math.max(uMax, p.u);
    vMin = Math.min(vMin, p.v);
    vMax = Math.max(vMax, p.v);
  }
  const uSpan = Math.max(1, uMax - uMin);
  const vSpan = Math.max(1, vMax - vMin);

  // Ridges: one central ridge, plus flanking ridges on wide maps.
  const ridgeCount = mainCols >= 9 ? 2 : 1;
  const ridges = Array.from({ length: ridgeCount }, (_, i) => ({
    u: ridgeCount === 1 ? 0.5 : 0.36 + i * 0.28,
    wobble: rng.next() * Math.PI * 2,
  }));
  // Defiles (passes) through each ridge at random latitudes.
  const passCount = Math.max(2, Math.round(mainRows / 2));
  const passes = Array.from({ length: passCount }, (_, i) => {
    const slot = (i + 0.5) / passCount;
    return Math.min(0.95, Math.max(0.05, slot + (rng.next() - 0.5) * (0.6 / passCount)));
  });

  const cellScale = 1 / (subRadius * 2.2); // noise frequency relative to main-hex size
  const ridgeHalfWidth = 0.06 + (0.012 * subRadius) / Math.max(1, mainCols / 7);
  const passHalfWidth = Math.max(0.035, 1.6 / vSpan);

  const heights = new Int8Array(world.subs.length);
  pts.forEach((p, i) => {
    const un = (p.u - uMin) / uSpan;
    const vn = (p.v - vMin) / vSpan;

    // Flank plateaus (H≈4) sloping to low ground (H≈2) toward the ridge valleys.
    const edge = Math.min(un, 1 - un);
    let h = 2.2 + 2.4 * Math.exp(-((edge - 0.14) ** 2) / 0.02);

    for (const r of ridges) {
      const centre = r.u + 0.03 * Math.sin(vn * Math.PI * 2 + r.wobble);
      const d = Math.abs(un - centre) / ridgeHalfWidth;
      if (d < 2.4) {
        let ridge = 7.8 * Math.exp(-(d * d) / 1.4);
        for (const pv of passes) {
          const pd = Math.abs(vn - pv) / passHalfWidth;
          if (pd < 1.8) ridge *= Math.min(1, 0.12 + 0.88 * (pd / 1.8) ** 2);
        }
        h = Math.max(h, ridge);
      }
    }

    const n = fbm(noise, p.u * cellScale, p.v * cellScale) - 0.5;
    h += n * 3.2;
    heights[i] = Math.max(0, Math.min(MAX_HEIGHT, Math.round(h)));
  });

  const mainHeight = new Map<string, number>();
  for (const m of world.mains) {
    let sum = 0;
    for (const k of m.subKeys) sum += heights[world.subByKey.get(k)!.index]!;
    mainHeight.set(m.key, sum / m.subKeys.length);
  }

  const terrain: Terrain = { heights, mainHeight, passes };
  terrainCache.set(cacheKey, terrain);
  return terrain;
}

export function heightAt(world: World, terrain: Terrain, key: string): number {
  const s = world.subByKey.get(key);
  return s ? terrain.heights[s.index]! : 0;
}
