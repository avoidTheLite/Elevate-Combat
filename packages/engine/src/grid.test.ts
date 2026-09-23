import { describe, expect, it } from 'vitest';
import { DIRECTIONS, hexDistance, hexKey, hexToWorld, neighbor, spiral } from './hex.ts';
import {
  buildWorld,
  clusterSize,
  edgeSegment,
  mainBoundary,
  mainNeighbors,
  mainToSubCenter,
  subToMain,
} from './grid.ts';

const CONFIGS = [
  { mainCols: 3, mainRows: 3, subRadius: 2 },
  { mainCols: 7, mainRows: 5, subRadius: 4 },
  { mainCols: 12, mainRows: 10, subRadius: 6 },
  { mainCols: 5, mainRows: 4, subRadius: 3 },
];

describe('hierarchical grid — sub-hexes align across main hexes', () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    it(`radius-${n} clusters tile the plane with no gaps or overlaps`, () => {
      // Every sub-hex in a big window has exactly one owning main hex, within distance n.
      for (const s of spiral({ q: 0, r: 0 }, 6 * n + 6)) {
        const m = subToMain(s, n);
        expect(hexDistance(mainToSubCenter(m, n), s)).toBeLessThanOrEqual(n);
        // Uniqueness: no other nearby cluster also claims it.
        const claims = [m, ...DIRECTIONS.map((_, i) => neighbor(m, i))].filter(
          (c) => hexDistance(mainToSubCenter(c, n), s) <= n,
        );
        expect(claims).toHaveLength(1);
      }
    });

    it(`radius-${n}: main neighbours are 2n+1 sub-hexes apart in every direction`, () => {
      for (let d = 0; d < 6; d++) {
        const c = mainToSubCenter(neighbor({ q: 0, r: 0 }, d), n);
        expect(hexDistance(c, { q: 0, r: 0 })).toBe(2 * n + 1);
      }
    });
  }

  for (const cfg of CONFIGS) {
    const label = `${cfg.mainCols}x${cfg.mainRows} n=${cfg.subRadius}`;

    it(`${label}: every main hex has 3n²+3n+1 sub-hexes and the partition is exact`, () => {
      const w = buildWorld(cfg);
      expect(w.mains).toHaveLength(cfg.mainCols * cfg.mainRows);
      for (const m of w.mains) expect(m.subKeys).toHaveLength(clusterSize(cfg.subRadius));
      expect(w.subs).toHaveLength(cfg.mainCols * cfg.mainRows * clusterSize(cfg.subRadius));
      // No sub-hex is listed twice.
      expect(new Set(w.subs.map((s) => s.key)).size).toBe(w.subs.length);
      // Every sub-hex's lattice owner matches the main hex that generated it.
      for (const s of w.subs) expect(hexKey(subToMain(s.hex, cfg.subRadius))).toBe(s.main);
    });

    it(`${label}: sub-hexes on both sides of every main border are direct neighbours`, () => {
      const w = buildWorld(cfg);
      let crossings = 0;
      for (const m of w.mains) {
        for (const e of mainBoundary(w, m.key)) {
          if (!e.otherMain) continue;
          const inner = w.subByKey.get(e.sub)!;
          const outer = w.subByKey.get(hexKey(neighbor(inner.hex, e.dir)))!;
          expect(outer.main).toBe(e.otherMain);
          expect(hexDistance(inner.hex, outer.hex)).toBe(1);
          // The world-space edge is shared exactly: same segment seen from either side.
          const a = edgeSegment(w, e);
          const back = mainBoundary(w, e.otherMain).find(
            (x) => x.sub === outer.key && x.dir === (e.dir + 3) % 6,
          )!;
          const b = edgeSegment(w, back);
          const close = (p: { x: number; z: number }, q: { x: number; z: number }): boolean =>
            Math.hypot(p.x - q.x, p.z - q.z) < 1e-9;
          expect((close(a.a, b.b) && close(a.b, b.a)) || (close(a.a, b.a) && close(a.b, b.b))).toBe(
            true,
          );
          crossings++;
        }
      }
      expect(crossings).toBeGreaterThan(0);
    });

    it(`${label}: adjacent main hexes share a border of 2n+1 sub-hex edges`, () => {
      const w = buildWorld(cfg);
      for (const m of w.mains) {
        for (const nb of mainNeighbors(w, m.key)) {
          const shared = mainBoundary(w, m.key).filter((e) => e.otherMain === nb.key);
          expect(shared).toHaveLength(2 * cfg.subRadius + 1);
        }
      }
    });

    it(`${label}: sub-hex centres sit on one global lattice (uniform spacing)`, () => {
      const w = buildWorld(cfg);
      const spacing = Math.sqrt(3);
      for (const s of w.subs.slice(0, 400)) {
        const c = hexToWorld(s.hex);
        for (let d = 0; d < 6; d++) {
          const nk = hexKey(neighbor(s.hex, d));
          if (!w.subByKey.has(nk)) continue;
          const nc = hexToWorld(neighbor(s.hex, d));
          expect(Math.hypot(nc.x - c.x, nc.z - c.z)).toBeCloseTo(spacing, 9);
        }
      }
    });
  }
});
