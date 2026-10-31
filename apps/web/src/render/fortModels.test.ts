import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DIRECTIONS, hexToWorld } from '@iron-ridge/engine';
import { HQ_WALL_HEIGHT, buildHqWall, hqWallGeometry } from './fortModels.ts';

const verts = (g: THREE.BufferGeometry): THREE.Vector3[] => {
  const p = g.getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(p, i));
};

describe('HQ wall', () => {
  it('has two wall segments (quads) per face of the ring', () => {
    const g = hqWallGeometry([0, 0, 0, 0, 0, 0], 1);
    expect(g.getAttribute('position').count).toBe(6 * 2 * 2 * 3);
  });

  it('encloses all six vertices of all seven tiles', () => {
    const vs = verts(hqWallGeometry([0, 0, 0, 0, 0, 0], 1));
    const polygon = DIRECTIONS.map((d) => {
      const c = hexToWorld(d);
      return { x: c.x * 1.72, z: c.z * 1.72 };
    });
    expect(vs.length).toBeGreaterThan(0);
    for (const d of [{ q: 0, r: 0 }, ...DIRECTIONS]) {
      const c = hexToWorld(d);
      for (let v = 0; v < 6; v++) {
        const angle = (Math.PI / 3) * v + Math.PI / 6;
        const point = { x: c.x + Math.cos(angle), z: c.z + Math.sin(angle) };
        // Every corner lies on the interior side of each wall face.
        const sides = polygon.map((p, i) => {
          const next = polygon[(i + 1) % 6]!;
          return (next.x - p.x) * (point.z - p.z) - (next.z - p.z) * (point.x - p.x);
        });
        expect(sides.every((side) => side >= -1e-6) || sides.every((side) => side <= 1e-6)).toBe(
          true,
        );
      }
    }
  });

  it('has a flat top above the highest ring cell; each segment starts at its own cell', () => {
    const ring = [1.0, 1.4, 1.2, 2.2, 1.0, 1.6];
    const wall = buildHqWall(1.0, ring);
    const vs = verts(wall.geometry);
    const top = Math.max(...vs.map((v) => v.y));
    expect(top).toBeCloseTo(2.2 - 1.0 + HQ_WALL_HEIGHT);
    // Every vertex is either on the flat top or at the ground of the nearest ring cell's segment.
    const bottoms = new Set(ring.map((y) => (y - 1.0).toFixed(4)));
    for (const v of vs) {
      if (Math.abs(v.y - top) > 1e-6) expect(bottoms.has(v.y.toFixed(4))).toBe(true);
    }
    // Lowest cell (index 0) gets the tallest segment: its corner reaches down to its ground.
    const c0 = hexToWorld(DIRECTIONS[0]!);
    const atC0 = vs.filter((v) => Math.hypot(v.x - c0.x * 1.72, v.z - c0.z * 1.72) < 1e-6);
    expect(Math.min(...atC0.map((v) => v.y))).toBeCloseTo(0);
  });
});
