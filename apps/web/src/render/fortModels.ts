// ── Fortification models: gold wireframe walls ───────────────────────────────
// A fortified cell gets a low open hex ring; an HQ gets a larger curtain wall
// tracing the centres of the six cells around it (two wall segments per face).

import * as THREE from 'three';
import { DIRECTIONS, hexToWorld } from '@iron-ridge/engine';

export const FORT_COLOR = 0xffc34d;
/** HQ wall colour — kept separate from FORT_COLOR so it can become the team colour later. */
export const HQ_WALL_COLOR = FORT_COLOR;
/** Height of the HQ wall above the highest ring cell (world units). */
export const HQ_WALL_HEIGHT = 0.36;
/** Height of a fort ring per fortification level (world units). */
export const FORT_LEVEL_HEIGHT = 0.12;

export function fortMaterial(color = FORT_COLOR): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.85 });
}

/** Single-cell fort ring: open hex wall, 1 unit tall with its base at y = 0 (scale Y by level). */
export function fortRingGeometry(): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(0.8, 0.88, 1, 6, 1, true);
  geo.translate(0, 0.5, 0);
  return geo;
}

/**
 * HQ curtain wall around a centre cell at the origin. Its corners are the centres of
 * the six ring cells (`DIRECTIONS` order); each face is split at its midpoint into two
 * segments, one per ring cell it passes over. `bottoms[i]` is the ground height of ring
 * cell i; every segment rises from its own cell's ground to the shared flat `top`.
 */
export function hqWallGeometry(bottoms: readonly number[], top: number): THREE.BufferGeometry {
  const corners = DIRECTIONS.map((d) => hexToWorld(d));
  const pos: number[] = [];
  const quad = (a: { x: number; z: number }, b: { x: number; z: number }, y0: number): void => {
    pos.push(a.x, y0, a.z, b.x, y0, b.z, b.x, top, b.z);
    pos.push(a.x, y0, a.z, b.x, top, b.z, a.x, top, a.z);
  };
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const a = corners[i]!;
    const b = corners[j]!;
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    quad(a, mid, bottoms[i]!);
    quad(mid, b, bottoms[j]!);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * HQ wall mesh relative to the centre cell's top. `ring` holds the ground heights
 * (world y) of the six surrounding cells; the wall top sits HQ_WALL_HEIGHT above the
 * highest of them so it reads flat.
 */
export function buildHqWall(centerY: number, ring: readonly number[]): THREE.Mesh {
  const bottoms = ring.map((y) => y - centerY);
  const top = Math.max(...bottoms) + HQ_WALL_HEIGHT;
  const mesh = new THREE.Mesh(hqWallGeometry(bottoms, top), fortMaterial(HQ_WALL_COLOR));
  mesh.name = 'hq-wall';
  return mesh;
}
