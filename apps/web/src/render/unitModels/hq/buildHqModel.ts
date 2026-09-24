import type { Era } from '@iron-ridge/engine';
import type * as THREE from 'three';
import { makeKit, type ModelOptions } from '../shared/index.ts';
import { medievalHq } from './medievalHq.ts';
import { ww2Hq } from './ww2Hq.ts';

/** Strategic HQ building for the era. Faces +X (gate / command door). */
export function buildHqModel(era: Era, o: ModelOptions): THREE.Group {
  const k = makeKit(o);
  if (era === 'ww2') ww2Hq(k);
  else medievalHq(k);
  k.root.name = 'hq';
  return k.root;
}
