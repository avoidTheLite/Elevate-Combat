import * as THREE from 'three';
import { barrelGeo, figure, hands, part, type Kit } from '../../shared/index.ts';

export function spearman(k: Kit): void {
  const f = figure(k, k.root, { helmet: true });
  const spear = new THREE.Group();
  spear.position.set(-0.2, 0.2, 0.1);
  spear.rotation.z = 0.12;
  part(k, spear, barrelGeo(0.018, 0.95), k.metal, [0, 0, 0], { name: 'weapon' });
  const tip = new THREE.ConeGeometry(0.045, 0.13, 4);
  tip.rotateZ(-Math.PI / 2);
  part(k, spear, tip, k.metal, [1.0, 0, 0]);
  f.add(spear);
  hands(k, f, [0.06, 0.22, 0.1], [0.28, 0.25, 0.1]);
}
