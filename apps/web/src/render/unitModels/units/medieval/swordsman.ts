import * as THREE from 'three';
import { box, figure, hands, part, type Kit } from '../../shared/index.ts';

export function swordsman(k: Kit): void {
  const f = figure(k, k.root, { helmet: true });
  part(k, f, box(0.4, 0.035, 0.05), k.metal, [0.34, 0.24, 0.12], { name: 'weapon' });
  part(k, f, box(0.04, 0.1, 0.04), k.dark, [0.13, 0.24, 0.12]); // crossguard
  part(k, f, new THREE.CylinderGeometry(0.15, 0.15, 0.035, 6), k.light, [0.16, 0.22, -0.16], {
    rot: [0, 0, Math.PI / 2],
    edges: true,
    name: 'shield',
  });
  hands(k, f, [0.1, 0.24, 0.12], [0.13, 0.22, -0.14]);
}
