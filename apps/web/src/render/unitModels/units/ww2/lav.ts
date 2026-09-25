import { barrelGeo, box, part, wheelGeo, type Kit } from '../../shared/index.ts';

export function lav(k: Kit): void {
  part(k, k.root, box(0.78, 0.26, 0.44), k.body, [0, 0.28, 0], { edges: true, name: 'hull' });
  for (const x of [0.25, -0.25])
    for (const z of [0.24, -0.24]) part(k, k.root, wheelGeo(0.13, 0.08), k.dark, [x, 0.13, z]);
  part(k, k.root, box(0.26, 0.13, 0.24), k.light, [-0.04, 0.47, 0], {
    edges: true,
    name: 'turret',
  });
  part(k, k.root, barrelGeo(0.026, 0.36), k.metal, [0.08, 0.48, 0], { name: 'barrel' });
}
