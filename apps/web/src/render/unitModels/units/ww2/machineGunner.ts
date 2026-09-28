import { barrelGeo, box, figure, hands, part, type Kit } from '../../shared/index.ts';

export function machineGunner(k: Kit): void {
  const f = figure(k, k.root, { helmet: true });
  part(k, f, box(0.24, 0.1, 0.11), k.metal, [0.22, 0.24, 0.06], { name: 'weapon' });
  part(k, f, barrelGeo(0.028, 0.34), k.metal, [0.34, 0.25, 0.06], { name: 'barrel' });
  part(k, f, box(0.1, 0.07, 0.09), k.dark, [0.2, 0.32, 0.06]); // ammo box
  hands(k, f, [0.12, 0.23, 0.12], [0.3, 0.22, 0.12]);
}
