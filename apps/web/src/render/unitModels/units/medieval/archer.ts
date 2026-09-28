import * as THREE from 'three';
import { figure, hands, part, type Kit } from '../../shared/index.ts';

export function archer(k: Kit): void {
  const f = figure(k, k.root, {});
  const bow = new THREE.TorusGeometry(0.26, 0.026, 4, 10, Math.PI);
  bow.rotateZ(-Math.PI / 2); // arc bulges forward (+X), limbs up/down
  part(k, f, bow, k.metal, [0.22, 0.3, 0], { name: 'weapon' });
  hands(k, f, [0.48, 0.3, 0], [0.12, 0.3, 0]);
}
