import type * as THREE from 'three';
import { makeKit, type Kit, type ModelOptions } from '../shared/index.ts';
import {
  atGun,
  bazooka,
  lav,
  machineGunner,
  mortarTeam,
  motorArtillery,
  rifleman,
  tank,
} from './ww2/index.ts';
import { archer, catapult, horseman, spearman, swordsman } from './medieval/index.ts';
import { engineer } from './common/engineer.ts';

const BUILDERS: Record<string, (k: Kit) => void> = {
  ww2_rifle_infantry: (k) => rifleman(k),
  ww2_machine_gun: machineGunner,
  ww2_at_infantry: bazooka,
  ww2_mortar: mortarTeam,
  ww2_engineer: (k) => engineer(k, true),
  ww2_tank: tank,
  ww2_at_gun: atGun,
  ww2_light_armored_vehicle: lav,
  ww2_artillery: motorArtillery,
  med_infantry: swordsman,
  med_spearman: spearman,
  med_archers: archer,
  med_horseman: horseman,
  med_engineer: (k) => engineer(k, false),
  med_artillery: catapult,
};

export function hasUnitModel(typeId: string): boolean {
  return typeId in BUILDERS;
}

/** Build the model for a unit type, facing +X, base on y = 0. */
export function buildUnitModel(typeId: string, o: ModelOptions): THREE.Group {
  const k = makeKit(o);
  (BUILDERS[typeId] ?? ((kit: Kit) => rifleman(kit)))(k);
  k.root.name = typeId;
  return k.root;
}
