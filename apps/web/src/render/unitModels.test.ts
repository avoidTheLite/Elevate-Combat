import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { UNIT_TYPES } from '@iron-ridge/engine';
import {
  MAX_ESCORTS,
  armyEscorts,
  buildArmyModel,
  buildFormationModel,
  buildHqModel,
  buildUnitModel,
  hasUnitModel,
  modelTop,
} from './unitModels.ts';

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

  it('Tron look: every part is the team colour except the weapons', () => {
    const team = new THREE.Color(0x00f0ff).getHex();
    const weaponIds = new Set(['weapon', 'barrel']);
    for (const id of Object.keys(UNIT_TYPES)) {
      const colours = new Set<number>();
      build(id).traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const c = (m.material as THREE.MeshLambertMaterial).color.getHex();
        if (c !== team) {
          // Anything not team-coloured must be weapon metal.
          colours.add(c);
        }
      });
      expect(colours.size).toBeLessThanOrEqual(1);
    }
    // And the neutral colour really is on the weapons.
    const mg = build('ww2_machine_gun');
    for (const name of weaponIds) {
      mg.traverse((o) => {
        if (o.name === name)
          expect(((o as THREE.Mesh).material as THREE.MeshLambertMaterial).color.getHex()).not.toBe(
            team,
          );
      });
    }
  });
});

describe('army commander clusters', () => {
  const ww2 = [
    'ww2_rifle_infantry',
    'ww2_rifle_infantry',
    'ww2_machine_gun',
    'ww2_at_infantry',
    'ww2_tank',
    'ww2_engineer',
  ];
  const med = [
    'med_infantry',
    'med_infantry',
    'med_spearman',
    'med_archers',
    'med_horseman',
    'med_engineer',
  ];
  const army = (era: 'ww2' | 'medieval', units: string[]): THREE.Group =>
    buildArmyModel(era, units, { color: 0x00f0ff, opacity: 1 });
  const find = (g: THREE.Object3D, name: string): THREE.Object3D[] => {
    const out: THREE.Object3D[] = [];
    g.traverse((o) => {
      if (o.name === name) out.push(o);
    });
    return out;
  };
  const gold = (o: THREE.Object3D): boolean => {
    let found = false;
    o.traverse((x) => {
      const m = x as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.MeshLambertMaterial).color.getHex() === 0xffcc33)
        found = true;
    });
    return found;
  };

  it('escorts are a reduced sample: never more than 3', () => {
    expect(armyEscorts(ww2).length).toBeLessThanOrEqual(MAX_ESCORTS);
    expect(armyEscorts([...ww2, ...ww2]).length).toBe(MAX_ESCORTS);
    expect(armyEscorts(['ww2_tank'])).toEqual(['ww2_tank']);
    expect(armyEscorts([])).toEqual([]);
  });

  it('each category present gets a slot, biggest category first', () => {
    // 5 infantry-class, 1 armor → infantry rep first, then the tank, then more variety.
    expect(armyEscorts(ww2)).toEqual(['ww2_rifle_infantry', 'ww2_tank', 'ww2_machine_gun']);
    const mixed = ['ww2_mortar', 'ww2_tank', 'ww2_tank', 'ww2_rifle_infantry'];
    expect(armyEscorts(mixed)).toEqual(['ww2_tank', 'ww2_mortar', 'ww2_rifle_infantry']);
  });

  it('a single-category army still shows variety, not clones', () => {
    const inf = [
      'ww2_rifle_infantry',
      'ww2_rifle_infantry',
      'ww2_rifle_infantry',
      'ww2_machine_gun',
      'ww2_at_infantry',
    ];
    expect(armyEscorts(inf)).toEqual(['ww2_rifle_infantry', 'ww2_machine_gun', 'ww2_at_infantry']);
  });

  it('WW2 commander is a covered truck with a gold star on the hood', () => {
    const g = army('ww2', ww2);
    const cmd = find(g, 'commander')[0]!;
    expect(find(cmd, 'cover')).toHaveLength(1);
    const star = find(cmd, 'star')[0]!;
    expect(gold(star)).toBe(true);
    // Star sits on the hood (front of the truck).
    expect(star.position.x).toBeCloseTo(find(cmd, 'hood')[0]!.position.x, 5);
    expect(find(g, 'roster-unit')).toHaveLength(ww2.length);
  });

  it('medieval commander rides a horse with a gold crown, beside a horse-cart', () => {
    const g = army('medieval', med);
    const cmd = find(g, 'commander')[0]!;
    expect(find(cmd, 'horse').length).toBeGreaterThanOrEqual(1);
    const crown = find(cmd, 'crown')[0]!;
    expect(gold(crown)).toBe(true);
    const cart = find(g, 'cart')[0]!;
    expect(find(cart, 'cover')).toHaveLength(1);
    expect(find(cart, 'horse')).toHaveLength(1);
  });

  it('only weapons and gold insignia differ from the team colour', () => {
    const team = new THREE.Color(0x00f0ff).getHex();
    for (const g of [army('ww2', ww2), army('medieval', med)]) {
      const colours = new Set<number>();
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) colours.add((m.material as THREE.MeshLambertMaterial).color.getHex());
      });
      colours.delete(team);
      expect([...colours].sort()).toEqual([0xdfe8ee, 0xffcc33].sort());
    }
  });

  it('uses each actual roster identity, duplicate type and facing instead of an escort sample', () => {
    const roster = [...ww2, ...ww2].map((typeId, index) => ({
      id: `unit-${index}`,
      typeId,
      facing: index % 6,
    }));
    const g = buildArmyModel('ww2', roster, { color: 0x00f0ff, opacity: 1 });
    const shown = find(g, 'roster-unit');
    expect(shown).toHaveLength(roster.length);
    expect(shown.map((unit) => unit.userData.unitId).sort()).toEqual(
      roster.map((unit) => unit.id).sort(),
    );
    for (const unit of shown) {
      const source = roster.find((entry) => entry.id === unit.userData.unitId)!;
      expect(unit.userData.facing).toBe(source.facing);
      expect(unit.userData.typeId).toBe(source.typeId);
    }
    const reversed = buildArmyModel('ww2', [...roster].reverse(), { color: 0x00f0ff, opacity: 1 });
    expect(reversed.children.map((unit) => unit.userData)).toEqual(
      g.children.map((unit) => unit.userData),
    );
  });

  it('keeps the actual full geometry inside the hex for both eras and tactical tokens', () => {
    const models = [army('ww2', [...ww2, ...ww2]), army('medieval', [...med, ...med])];
    for (const typeId of Object.keys(UNIT_TYPES))
      for (let facing = 0; facing < 6; facing++)
        models.push(
          buildFormationModel([{ id: typeId, typeId, facing }], { color: 0x00f0ff, opacity: 1 }),
        );
    const point = new THREE.Vector3();
    const normals = Array.from({ length: 6 }, (_, side) => ({
      x: Math.cos((side * Math.PI) / 3),
      z: Math.sin((side * Math.PI) / 3),
    }));
    let maximumProjection = -Infinity;
    for (const model of models) {
      model.updateMatrixWorld(true);
      model.traverse((object) => {
        const mesh = object as THREE.Mesh;
        const positions = mesh.geometry?.getAttribute('position');
        if (!positions) return;
        for (let i = 0; i < positions.count; i++) {
          point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
          for (const normal of normals)
            maximumProjection = Math.max(
              maximumProjection,
              point.x * normal.x + point.z * normal.z,
            );
        }
      });
    }
    expect(maximumProjection).toBeLessThanOrEqual(Math.sqrt(3) / 2 + 1e-7);
  });

  it('places token labels above actual models, excluding glows, hidden proxies and world height', () => {
    const parent = new THREE.Group();
    parent.position.set(10, 20, 30);
    const body = new THREE.Group();
    const visible = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    visible.position.y = 0.5;
    body.add(visible);
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20));
    hidden.visible = false;
    body.add(hidden);
    const glow = new THREE.Sprite();
    glow.scale.setScalar(50);
    body.add(glow);
    body.scale.setScalar(0.75);
    parent.add(body);
    expect(modelTop(body)).toBeCloseTo(0.75);
    const fitted = army('ww2', ww2);
    expect(modelTop(fitted)).toBeGreaterThan(0);
    expect(modelTop(fitted)).toBeLessThan(1);
  });
});

describe('HQ buildings', () => {
  const hq = (era: 'ww2' | 'medieval'): THREE.Group =>
    buildHqModel(era, { color: 0x00f0ff, opacity: 1 });

  it('WW2: two half-cylinder barracks and a gabled command building', () => {
    const g = hq('ww2');
    const huts = named(g, 'hut');
    expect(huts).toHaveLength(2);
    for (const h of huts) {
      const p = h.geometry as THREE.CylinderGeometry;
      expect(p.type).toBe('CylinderGeometry');
      expect(p.parameters.thetaLength).toBeCloseTo(Math.PI);
    }
    expect(named(g, 'hall')).toHaveLength(1);
    expect(named(g, 'roof')[0]!.geometry.type).toBe('ExtrudeGeometry');
  });

  it('Medieval: four towers, curtain walls and a drawbridge gate', () => {
    const g = hq('medieval');
    expect(named(g, 'tower')).toHaveLength(4);
    expect(named(g, 'wall').length).toBeGreaterThanOrEqual(4);
    expect(named(g, 'drawbridge')).toHaveLength(1);
    // The drawbridge lies outside the front (+X) wall.
    const wallX = Math.max(...named(g, 'tower').map((t) => t.position.x));
    expect(named(g, 'drawbridge')[0]!.position.x).toBeGreaterThan(wallX);
  });

  it.each(['ww2', 'medieval'] as const)('%s fits inside the HQ wall', (era) => {
    const b = new THREE.Box3().setFromObject(hq(era));
    // Wall faces are ~1.5 from the centre (apothem of the ring-centre hexagon).
    for (const v of [b.min.x, b.max.x, b.min.z, b.max.z]) expect(Math.abs(v)).toBeLessThan(1.3);
  });
});
