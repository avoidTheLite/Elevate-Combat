import { barrelGeo, figure, hands, part, type Kit } from '../../shared/index.ts';

export function bazooka(k: Kit): void {
  const f = figure(k, k.root, { helmet: true });
  const tube = barrelGeo(0.065, 0.62);
  tube.translate(-0.24, 0, 0);
  part(k, f, tube, k.metal, [0, 0.4, 0.15], { name: 'barrel' });
  hands(k, f, [0.1, 0.34, 0.14], [0.24, 0.36, 0.14]);
}
