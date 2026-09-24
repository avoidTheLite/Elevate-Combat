import * as THREE from 'three';
import { box, part } from './primitives.ts';
import type { Kit, V3 } from './types.ts';

/** Boxy horse (faces +X), added to `parent`. */
export function horse(k: Kit, parent: THREE.Object3D, pos: V3 = [0, 0, 0], scale = 1): THREE.Group {
  const h = new THREE.Group();
  h.position.set(...pos);
  h.scale.setScalar(scale);
  part(k, h, box(0.56, 0.22, 0.26), k.light, [0, 0.34, 0], { edges: true, name: 'horse' });
  part(k, h, box(0.16, 0.24, 0.14), k.light, [0.3, 0.5, 0]); // neck + head
  part(k, h, box(0.18, 0.1, 0.13), k.light, [0.38, 0.58, 0]); // muzzle
  for (const [x, z] of [
    [0.2, 0.09],
    [0.2, -0.09],
    [-0.2, 0.09],
    [-0.2, -0.09],
  ] as const) {
    part(k, h, new THREE.CylinderGeometry(0.045, 0.045, 0.24, 6), k.dark, [x, 0.12, z]);
  }
  parent.add(h);
  return h;
}
