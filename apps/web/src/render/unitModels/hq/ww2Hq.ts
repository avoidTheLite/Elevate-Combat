import * as THREE from 'three';
import { box, coverGeo, gableRoofGeo, part, type Kit } from '../shared/index.ts';

/** WW2 HQ: two Quonset-hut barracks and a gabled command building. */
export function ww2Hq(k: Kit): void {
  for (const z of [-0.5, 0.5]) {
    const hut = new THREE.Group();
    hut.name = 'barracks';
    hut.position.set(-0.35, 0, z);
    part(k, hut, coverGeo(0.26, 0.9), k.body, [0, 0, 0], { name: 'hut' });
    part(k, hut, box(0.04, 0.16, 0.12), k.metal, [0.46, 0.08, 0], { name: 'door' });
    k.root.add(hut);
  }
  const hall = new THREE.Group();
  hall.name = 'command';
  hall.position.set(0.55, 0, 0);
  part(k, hall, box(0.5, 0.34, 0.8), k.body, [0, 0.17, 0], { name: 'hall' });
  part(k, hall, gableRoofGeo(0.62, 0.24, 0.92), k.body, [0, 0.34, 0], { name: 'roof' });
  part(k, hall, box(0.04, 0.18, 0.14), k.metal, [0.26, 0.09, 0], { name: 'door' });
  k.root.add(hall);
}
