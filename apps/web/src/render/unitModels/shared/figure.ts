import * as THREE from 'three';
import { ball, part } from './primitives.ts';
import type { FigureOpts, Kit, V3 } from './types.ts';

/** Chibi soldier: stubby tapered body, oversized head. Returns the figure group. */
export function figure(k: Kit, parent: THREE.Object3D, o: FigureOpts = {}): THREE.Group {
  const f = new THREE.Group();
  f.position.y = o.y ?? 0;
  f.scale.setScalar(o.scale ?? 1);
  part(k, f, new THREE.CylinderGeometry(0.14, 0.2, 0.3, 6), k.body, [0, 0.15, 0], {
    edges: true,
    name: 'body',
  });
  part(k, f, ball(0.17), k.skin, [0, 0.46, 0], { name: 'head' });
  if (o.helmet) {
    part(
      k,
      f,
      new THREE.SphereGeometry(0.185, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
      k.body,
      [0, 0.5, 0],
    );
  }
  if (o.hardHat) {
    part(
      k,
      f,
      new THREE.SphereGeometry(0.18, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
      k.metal,
      [0, 0.51, 0],
    );
    part(k, f, new THREE.CylinderGeometry(0.24, 0.24, 0.025, 8), k.metal, [0, 0.51, 0]);
  }
  parent.add(f);
  return f;
}

export function hands(k: Kit, parent: THREE.Object3D, ...pts: V3[]): void {
  for (const p of pts) part(k, parent, ball(0.055), k.skin, p, { name: 'hand' });
}
