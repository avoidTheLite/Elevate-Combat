import * as THREE from 'three';
import { barrelGeo, box, part, type Kit } from '../shared/index.ts';

/** Medieval HQ: square keep — four corner towers, curtain walls, drawbridge gate at +X. */
export function medievalHq(k: Kit): void {
  const half = 0.55;
  const wallH = 0.4;
  const thick = 0.1;
  for (const x of [-half, half])
    for (const z of [-half, half]) {
      part(k, k.root, new THREE.CylinderGeometry(0.15, 0.17, 0.62, 8), k.body, [x, 0.31, z], {
        name: 'tower',
      });
      part(k, k.root, new THREE.ConeGeometry(0.19, 0.22, 8), k.body, [x, 0.73, z], {
        name: 'spire',
      });
    }
  const len = 2 * half;
  part(k, k.root, box(thick, wallH, len), k.body, [-half, wallH / 2, 0], { name: 'wall' });
  part(k, k.root, box(len, wallH, thick), k.body, [0, wallH / 2, -half], { name: 'wall' });
  part(k, k.root, box(len, wallH, thick), k.body, [0, wallH / 2, half], { name: 'wall' });
  // Front wall: two stubs either side of the gate, a lintel above it.
  const gate = 0.3;
  const stub = (len - gate) / 2;
  for (const s of [-1, 1])
    part(k, k.root, box(thick, wallH, stub), k.body, [half, wallH / 2, (s * (gate + stub)) / 2], {
      name: 'wall',
    });
  part(k, k.root, box(thick, wallH - 0.26, gate), k.body, [half, 0.26 + (wallH - 0.26) / 2, 0], {
    name: 'lintel',
  });
  // Lowered drawbridge with its chains.
  part(k, k.root, box(0.36, 0.03, gate - 0.04), k.metal, [half + 0.2, 0.015, 0], {
    name: 'drawbridge',
    edges: true,
  });
  for (const z of [-1, 1]) {
    const chain = part(k, k.root, barrelGeo(0.01, 0.43), k.metal, [half + 0.36, 0.03, z * 0.12], {
      name: 'chain',
    });
    chain.rotation.z = Math.PI - Math.atan2(0.23, 0.36); // up and back to the gate top
  }
}
