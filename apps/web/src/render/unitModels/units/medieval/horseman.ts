import { barrelGeo, crown, figure, hands, horse, part, type Kit } from '../../shared/index.ts';

export function horseman(k: Kit, o: { crown?: boolean } = {}): void {
  const h = horse(k, k.root);
  const rider = figure(k, h, { helmet: !o.crown, scale: 0.8, y: 0.44 });
  part(k, rider, barrelGeo(0.016, 0.7), k.metal, [0.05, 0.28, 0.14], { name: 'weapon' }); // lance
  hands(k, rider, [0.12, 0.28, 0.14]);
  if (o.crown) crown(k, rider, 0.66);
}
