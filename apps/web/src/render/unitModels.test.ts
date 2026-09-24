import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { UNIT_TYPES } from '@iron-ridge/engine';
import { buildUnitModel, hasUnitModel } from './unitModels.ts';

const build = (id: string): THREE.Group => buildUnitModel(id, { color: 0x00f0ff, opacity: 1 });
const named = (g: THREE.Object3D, name: string): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  g.traverse((o) => {
    if (o.name === name) out.push(o as THREE.Mesh);
  });
  return out;
};

describe('unit models', () => {
  it('every unit type has its own model', () => {
    for (const id of Object.keys(UNIT_TYPES)) {
      expect(hasUnitModel(id)).toBe(true);
      expect(build(id).children.length).toBeGreaterThan(0);
    }
  });

  it.each(['ww2_tank', 'ww2_at_gun', 'ww2_artillery', 'ww2_mortar', 'ww2_light_armored_vehicle'])(
    '%s has a cylinder barrel',
    (id) => {
      const barrels = named(build(id), 'barrel');
      expect(barrels.length).toBe(1);
      expect(barrels[0]!.geometry.type).toBe('CylinderGeometry');
    },
  );

  it.each([
    'ww2_rifle_infantry',
    'ww2_machine_gun',
    'ww2_at_infantry',
    'ww2_engineer',
    'med_infantry',
    'med_spearman',
    'med_archers',
  ])('%s is a figure: one body, one head, hands on the weapon', (id) => {
    const g = build(id);
    expect(named(g, 'body')).toHaveLength(1);
    expect(named(g, 'head')).toHaveLength(1);
    expect(named(g, 'hand').length).toBeGreaterThanOrEqual(2);
  });

  it('figures are "chibi": the head is wider than the body', () => {
    const g = build('ww2_rifle_infantry');
    const size = (m: THREE.Mesh): THREE.Vector3 =>
      new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
    expect(size(named(g, 'head')[0]!).y).toBeGreaterThan(size(named(g, 'body')[0]!).y);
  });

  it('the rifle is a single simple wedge; the machine gun is built from 3 parts', () => {
    const rifle = named(build('ww2_rifle_infantry'), 'weapon');
    expect(rifle).toHaveLength(1);
    expect(rifle[0]!.geometry.type).toBe('ConeGeometry');
    const mg = build('ww2_machine_gun');
    expect(named(mg, 'weapon').length + named(mg, 'barrel').length).toBe(2); // + ammo box
  });

  it.each(['ww2_tank', 'ww2_at_gun', 'ww2_rifle_infantry', 'med_spearman'])(
    '%s faces +X (its weapon points forward)',
    (id) => {
      const box = new THREE.Box3().setFromObject(build(id));
      expect(box.max.x).toBeGreaterThan(-box.min.x);
    },
  );
});
