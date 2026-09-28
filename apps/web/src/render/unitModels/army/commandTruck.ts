import * as THREE from 'three';
import { box, coverGeo, part, starGeo, wheelGeo, type Kit } from '../shared/index.ts';

/** WW2 command vehicle: covered truck with a gold star on the hood. */
export function commandTruck(k: Kit, parent: THREE.Object3D): void {
  const t = new THREE.Group();
  t.name = 'commander';
  part(k, t, box(0.18, 0.14, 0.36), k.body, [0.5, 0.24, 0], { name: 'hood' });
  part(k, t, box(0.24, 0.3, 0.4), k.body, [0.3, 0.32, 0], { name: 'cab' });
  part(k, t, box(0.56, 0.1, 0.42), k.body, [-0.12, 0.22, 0], { name: 'bed' });
  part(k, t, coverGeo(0.21, 0.56), k.body, [-0.12, 0.27, 0], { name: 'cover' });
  for (const x of [0.42, -0.22])
    for (const z of [0.22, -0.22]) part(k, t, wheelGeo(0.11, 0.07), k.dark, [x, 0.11, z]);
  const star = part(k, t, starGeo(0.1, 0.042, 0.015), k.gold, [0.5, 0.315, 0], { name: 'star' });
  star.rotation.y = -Math.PI / 2; // one point toward the front
  parent.add(t);
}
