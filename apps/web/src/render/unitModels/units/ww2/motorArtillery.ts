import * as THREE from 'three';
import { barrelGeo, box, part, wheelGeo, type Kit } from '../../shared/index.ts';

export function motorArtillery(k: Kit): void {
  part(k, k.root, box(0.26, 0.26, 0.42), k.light, [0.33, 0.3, 0], { edges: true, name: 'cab' });
  part(k, k.root, box(0.56, 0.14, 0.44), k.body, [-0.1, 0.24, 0], { edges: true, name: 'bed' });
  for (const x of [0.32, -0.08, -0.3])
    for (const z of [0.23, -0.23]) part(k, k.root, wheelGeo(0.11, 0.07), k.dark, [x, 0.11, z]);
  part(k, k.root, new THREE.CylinderGeometry(0.1, 0.12, 0.1, 6), k.metal, [-0.12, 0.36, 0]);
  const pivot = new THREE.Group();
  pivot.position.set(-0.12, 0.4, 0);
  pivot.rotation.z = Math.PI / 7; // raised for indirect fire
  part(k, pivot, barrelGeo(0.05, 0.9), k.metal, [0, 0, 0], { name: 'barrel' });
  k.root.add(pivot);
}
