import * as THREE from 'three';
import type { Kit, ModelOptions } from './types.ts';

export const NEUTRAL = 0xdfe8ee; // weapons / metal
export const GOLD = 0xffcc33; // commander insignia (crown / star)
/** Emissive share of the team colour — high, so units read as glowing light-forms. */
export const TEAM_GLOW = 0.6;

export function lambert(color: number, opacity: number, glow = 0.35): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(glow),
    transparent: opacity < 1,
    opacity,
  });
}

export function makeKit(o: ModelOptions): Kit {
  // Tron look: every structural part shares one bright, self-lit team colour;
  // only weapons differ (neutral light metal).
  const team = lambert(o.color, o.opacity, TEAM_GLOW);
  return {
    root: new THREE.Group(),
    body: team,
    light: team,
    skin: team,
    metal: lambert(NEUTRAL, o.opacity, 0.3),
    dark: team,
    gold: lambert(GOLD, o.opacity, 0.55),
    edge: new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.45 * o.opacity,
    }),
  };
}

/** Same materials, different root (so a sub-model can be positioned as a group). */
export function makeKitFrom(k: Kit, root: THREE.Group): Kit {
  return { ...k, root };
}
