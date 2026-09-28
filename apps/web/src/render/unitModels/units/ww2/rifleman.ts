import * as THREE from 'three';
import { figure, hands, part, type Kit } from '../../shared/index.ts';

export function rifleman(k: Kit, helmet = true): void {
  const f = figure(k, k.root, { helmet });
  // Rifle: the slim three-sided wedge (formerly the facing marker).
  const rifle = new THREE.ConeGeometry(0.045, 0.52, 3);
  rifle.rotateZ(-Math.PI / 2);
  part(k, f, rifle, k.metal, [0.3, 0.25, 0.06], { name: 'weapon' });
  hands(k, f, [0.14, 0.25, 0.08], [0.33, 0.25, 0.05]);
}
