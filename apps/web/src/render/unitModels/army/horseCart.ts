import * as THREE from 'three';
import { barrelGeo, box, coverGeo, horse, part, wheelGeo, type Kit, type V3 } from '../shared/index.ts';

/** Medieval baggage: a covered horse-cart. */
export function horseCart(k: Kit, parent: THREE.Object3D, pos: V3): void {
  const c = new THREE.Group();
  c.name = 'cart';
  c.position.set(...pos);
  part(k, c, box(0.46, 0.08, 0.34), k.body, [0, 0.24, 0], { name: 'bed' });
  part(k, c, coverGeo(0.17, 0.46), k.body, [0, 0.28, 0], { name: 'cover' });
  for (const z of [0.2, -0.2]) part(k, c, wheelGeo(0.14, 0.05), k.dark, [-0.02, 0.14, z]);
  for (const z of [0.08, -0.08]) part(k, c, barrelGeo(0.015, 0.36), k.body, [0.23, 0.22, z]); // shafts
  horse(k, c, [0.62, 0, 0], 0.75);
  parent.add(c);
}
