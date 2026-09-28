import * as THREE from 'three';
import { barrelGeo, figure, hands, part, type Kit } from '../../shared/index.ts';

export function mortarTeam(k: Kit): void {
  const f = figure(k, k.root, { helmet: true });
  f.position.x = -0.18;
  const plate = part(
    k,
    k.root,
    new THREE.CylinderGeometry(0.13, 0.13, 0.03, 6),
    k.dark,
    [0.2, 0.02, 0],
  );
  plate.name = 'baseplate';
  const pivot = new THREE.Group();
  pivot.position.set(0.2, 0.04, 0);
  pivot.rotation.z = Math.PI / 3; // tube raised 60°
  part(k, pivot, barrelGeo(0.055, 0.42), k.metal, [0, 0, 0], { name: 'barrel' });
  k.root.add(pivot);
  hands(k, k.root, [0.06, 0.28, 0.06], [0.1, 0.22, -0.06]);
}
