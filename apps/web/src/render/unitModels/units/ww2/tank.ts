import * as THREE from 'three';
import { barrelGeo, box, part, type Kit } from '../../shared/index.ts';

export function tank(k: Kit): void {
  part(k, k.root, box(0.78, 0.22, 0.5), k.body, [0, 0.22, 0], { edges: true, name: 'hull' });
  for (const z of [0.29, -0.29]) part(k, k.root, box(0.84, 0.18, 0.14), k.dark, [0, 0.1, z]);
  part(k, k.root, new THREE.CylinderGeometry(0.22, 0.25, 0.18, 6), k.light, [-0.04, 0.42, 0], {
    edges: true,
    name: 'turret',
  });
  part(k, k.root, barrelGeo(0.045, 0.56), k.metal, [0.14, 0.43, 0], { name: 'barrel' });
}
