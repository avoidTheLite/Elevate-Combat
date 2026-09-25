import * as THREE from 'three';
import { barrelGeo, box, figure, hands, part, type Kit } from '../../shared/index.ts';

export function engineer(k: Kit, ww2: boolean): void {
  const f = figure(k, k.root, { hardHat: ww2, helmet: !ww2 });
  // Shovel carried at the shoulder, blade forward and down (kept above ground).
  const tool = new THREE.Group();
  tool.position.set(-0.08, 0.44, 0.15);
  tool.rotation.z = -0.42;
  part(k, tool, barrelGeo(0.022, 0.46), k.metal, [0, 0, 0], { name: 'weapon' });
  part(k, tool, box(0.14, 0.04, 0.13), k.metal, [0.5, 0, 0], { rot: [0, 0, -0.9] }); // blade
  f.add(tool);
  hands(k, f, [0.06, 0.37, 0.15], [0.24, 0.29, 0.15]);
}
