import { barrelGeo, box, part, wheelGeo, type Kit } from '../../shared/index.ts';

export function atGun(k: Kit): void {
  part(k, k.root, box(0.06, 0.3, 0.48), k.body, [0.08, 0.3, 0], { edges: true, name: 'shield' });
  part(k, k.root, barrelGeo(0.038, 0.72), k.metal, [0.02, 0.3, 0], { name: 'barrel' });
  for (const z of [0.25, -0.25]) part(k, k.root, wheelGeo(0.14, 0.07), k.dark, [-0.02, 0.14, z]);
  part(k, k.root, box(0.5, 0.05, 0.07), k.light, [-0.3, 0.1, 0.08], { rot: [0, 0.25, 0] });
  part(k, k.root, box(0.5, 0.05, 0.07), k.light, [-0.3, 0.1, -0.08], { rot: [0, -0.25, 0] });
}
