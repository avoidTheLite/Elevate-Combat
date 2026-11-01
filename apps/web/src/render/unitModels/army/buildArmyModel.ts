import type { Era } from '@iron-ridge/engine';
import * as THREE from 'three';
import { makeKit, makeKitFrom, type ModelOptions } from '../shared/index.ts';
import { horseman } from '../units/medieval/horseman.ts';
import { assembleFormation, rosterModelMember, type RosterModelUnit } from '../formation.ts';
import { commandTruck } from './commandTruck.ts';
import { horseCart } from './horseCart.ts';

/**
 * Strategic commander marker and every actual constituent unit. Each unit's
 * facing determines its region; commander identity never replaces the roster.
 */
export function buildArmyModel(
  era: Era,
  units: readonly (string | RosterModelUnit)[],
  o: ModelOptions,
  markerFacing = 0,
): THREE.Group {
  const k = makeKit(o);
  if (era === 'ww2') {
    const truck = new THREE.Group();
    truck.position.x = -0.25;
    commandTruck(makeKitFrom(k, truck), truck);
    k.root.add(truck);
  } else {
    horseCart(k, k.root, [-0.55, 0, 0.2]);
    const cmd = new THREE.Group();
    cmd.name = 'commander';
    cmd.position.set(0.1, 0, -0.25);
    const sub = makeKitFrom(k, cmd);
    horseman(sub, { crown: true });
    k.root.add(cmd);
  }
  const roster = units.map((unit, index) =>
    typeof unit === 'string' ? { id: `roster-${index}`, typeId: unit, facing: 0 } : unit,
  );
  const unitIds = new Set(roster.map((unit) => unit.id));
  let markerId = 'commander-marker';
  while (unitIds.has(markerId)) markerId += ':';
  const root = assembleFormation([
    ...roster.map((unit) => rosterModelMember(unit, o)),
    {
      id: markerId,
      model: k.root,
      facing: markerFacing,
      role: 'support',
      infantry: false,
    },
  ]);
  root.name = 'army';
  return root;
}
