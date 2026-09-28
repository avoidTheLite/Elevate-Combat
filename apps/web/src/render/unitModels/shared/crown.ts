import * as THREE from 'three';
import { part } from './primitives.ts';
import type { Kit } from './types.ts';

/** Gold crown ring with points, sized for a figure's head. */
export function crown(k: Kit, parent: THREE.Object3D, y: number): void {
  const c = new THREE.Group();
  c.name = 'crown';
  c.position.y = y;
  part(k, c, new THREE.CylinderGeometry(0.13, 0.12, 0.07, 8, 1, true), k.gold, [0, 0, 0]);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    part(k, c, new THREE.ConeGeometry(0.035, 0.09, 4), k.gold, [
      Math.cos(a) * 0.12,
      0.075,
      Math.sin(a) * 0.12,
    ]);
  }
  parent.add(c);
}
