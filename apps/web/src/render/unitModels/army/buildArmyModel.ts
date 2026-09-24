import type { Era } from '@iron-ridge/engine';
import * as THREE from 'three';
import { makeKit, makeKitFrom, type ModelOptions, type V3 } from '../shared/index.ts';
import { horseman } from '../units/medieval/horseman.ts';
import { buildUnitModel } from '../units/builders.ts';
import { commandTruck } from './commandTruck.ts';
import { horseCart } from './horseCart.ts';
import { armyEscorts } from './escorts.ts';

/**
 * Strategic army token: commander (+ baggage) and a small escort sample.
 * Faces +X; the scene turns it toward the enemy.
 */
export function buildArmyModel(era: Era, typeIds: string[], o: ModelOptions): THREE.Group {
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
  // Escorts in a loose arc ahead of the commander.
  const slots: V3[] = [
    [1.1, 0, -0.7],
    [1.35, 0, 0.12],
    [1.0, 0, 0.9],
  ];
  armyEscorts(typeIds).forEach((id, i) => {
    const e = buildUnitModel(id, o);
    e.name = 'escort';
    e.position.set(...slots[i]!);
    e.scale.setScalar(0.72);
    k.root.add(e);
  });
  k.root.name = 'army';
  return k.root;
}
