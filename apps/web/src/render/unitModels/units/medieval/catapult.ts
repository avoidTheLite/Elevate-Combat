import * as THREE from 'three';
import { barrelGeo, box, part, wheelGeo, type Kit } from '../../shared/index.ts';

export function catapult(k: Kit): void {
  part(k, k.root, box(0.62, 0.08, 0.36), k.body, [0, 0.14, 0], { edges: true, name: 'frame' });
  for (const x of [0.22, -0.22])
    for (const z of [0.2, -0.2]) part(k, k.root, wheelGeo(0.1, 0.05), k.dark, [x, 0.1, z]);
  for (const z of [0.12, -0.12]) part(k, k.root, box(0.07, 0.34, 0.06), k.light, [0.06, 0.34, z]);
  const arm = new THREE.Group();
  arm.position.set(0.06, 0.46, 0);
  arm.rotation.z = Math.PI - 0.6; // throwing arm cocked back
  part(k, arm, barrelGeo(0.04, 0.62), k.metal, [0, 0, 0], { name: 'barrel' });
  part(k, arm, box(0.16, 0.07, 0.18), k.metal, [0.62, 0.03, 0]); // cup
  k.root.add(arm);
}
