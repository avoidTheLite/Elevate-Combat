// ── Unit models: chunky geometric primitives, "chibi" proportions ────────────
// Every model faces +X (the scene rotates it to the unit's facing). Figures get
// a big head, a short stubby body and ball hands that sit on their weapon;
// vehicles are short and chunky with oversized turrets and cylinder barrels.
// Team colour is the body; weapons are a neutral light metal.

import * as THREE from 'three';
import type { Era } from '@iron-ridge/engine';
import { unitType } from '@iron-ridge/engine';

export interface ModelOptions {
  color: number;
  opacity: number;
}

const NEUTRAL = 0xdfe8ee; // weapons / metal
const GOLD = 0xffcc33; // commander insignia (crown / star)
/** Emissive share of the team colour — high, so units read as glowing light-forms. */
const TEAM_GLOW = 0.6;

interface Kit {
  root: THREE.Group;
  body: THREE.Material;
  light: THREE.Material;
  skin: THREE.Material;
  metal: THREE.Material;
  dark: THREE.Material;
  gold: THREE.Material;
  edge: THREE.LineBasicMaterial;
}

function lambert(color: number, opacity: number, glow = 0.35): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(glow),
    transparent: opacity < 1,
    opacity,
  });
}

function makeKit(o: ModelOptions): Kit {
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

type V3 = [number, number, number];

/** Add a mesh at `pos` to `parent`; optional white edge outline for major parts. */
function part(
  k: Kit,
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  pos: V3,
  opts: { edges?: boolean; name?: string; rot?: V3 } = {},
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...pos);
  if (opts.rot) m.rotation.set(...opts.rot);
  if (opts.name) m.name = opts.name;
  // Team-coloured parts are all one colour, so outline each to keep the silhouette readable.
  if (opts.edges || mat === k.body) {
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), k.edge));
  }
  parent.add(m);
  return m;
}

/** Cylinder whose axis runs along +X, starting at the origin. */
function barrelGeo(radius: number, length: number, segments = 8): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, segments);
  g.rotateZ(-Math.PI / 2);
  g.translate(length / 2, 0, 0);
  return g;
}

/** Wheel: cylinder whose axis runs along Z. */
function wheelGeo(radius: number, width: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, width, 8);
  g.rotateX(Math.PI / 2);
  return g;
}

const box = (x: number, y: number, z: number): THREE.BufferGeometry =>
  new THREE.BoxGeometry(x, y, z);
const ball = (r: number): THREE.BufferGeometry => new THREE.IcosahedronGeometry(r, 1);

// ── Figures ──

interface FigureOpts {
  helmet?: boolean;
  hardHat?: boolean;
  scale?: number;
  y?: number;
}

/** Chibi soldier: stubby tapered body, oversized head. Returns the figure group. */
function figure(k: Kit, parent: THREE.Object3D, o: FigureOpts = {}): THREE.Group {
  const f = new THREE.Group();
  f.position.y = o.y ?? 0;
  f.scale.setScalar(o.scale ?? 1);
  part(k, f, new THREE.CylinderGeometry(0.14, 0.2, 0.3, 6), k.body, [0, 0.15, 0], {
    edges: true,
    name: 'body',
  });
  part(k, f, ball(0.17), k.skin, [0, 0.46, 0], { name: 'head' });
  if (o.helmet) {
    part(
      k,
      f,
      new THREE.SphereGeometry(0.185, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
      k.body,
      [0, 0.5, 0],
    );
  }
  if (o.hardHat) {
    part(
      k,
      f,
      new THREE.SphereGeometry(0.18, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
      k.metal,
      [0, 0.51, 0],
    );
    part(k, f, new THREE.CylinderGeometry(0.24, 0.24, 0.025, 8), k.metal, [0, 0.51, 0]);
  }
  parent.add(f);
  return f;
}

function hands(k: Kit, parent: THREE.Object3D, ...pts: V3[]): void {
  for (const p of pts) part(k, parent, ball(0.055), k.skin, p, { name: 'hand' });
}

// ── Infantry ──

function rifleman(k: Kit, helmet = true): void {
  const f = figure(k, k.root, { helmet });
  // Rifle: the slim three-sided wedge (formerly the facing marker).
  const rifle = new THREE.ConeGeometry(0.045, 0.52, 3);
  rifle.rotateZ(-Math.PI / 2);
  part(k, f, rifle, k.metal, [0.3, 0.25, 0.06], { name: 'weapon' });
  hands(k, f, [0.14, 0.25, 0.08], [0.33, 0.25, 0.05]);
}

function machineGunner(k: Kit): void {
  const f = figure(k, k.root, { helmet: true });
  part(k, f, box(0.24, 0.1, 0.11), k.metal, [0.22, 0.24, 0.06], { name: 'weapon' });
  part(k, f, barrelGeo(0.028, 0.34), k.metal, [0.34, 0.25, 0.06], { name: 'barrel' });
  part(k, f, box(0.1, 0.07, 0.09), k.dark, [0.2, 0.32, 0.06]); // ammo box
  hands(k, f, [0.12, 0.23, 0.12], [0.3, 0.22, 0.12]);
}

function bazooka(k: Kit): void {
  const f = figure(k, k.root, { helmet: true });
  const tube = barrelGeo(0.065, 0.62);
  tube.translate(-0.24, 0, 0);
  part(k, f, tube, k.metal, [0, 0.4, 0.15], { name: 'barrel' });
  hands(k, f, [0.1, 0.34, 0.14], [0.24, 0.36, 0.14]);
}

function mortarTeam(k: Kit): void {
  const f = figure(k, k.root, { helmet: true });
  f.position.x = -0.18;
  const plate = part(
    k,
    k.root,
    new THREE.CylinderGeometry(0.13, 0.13, 0.03, 6),
    k.dark,
    [0.2, 0.02, 0],
  );
  plate.name = 'baseplate';
  const pivot = new THREE.Group();
  pivot.position.set(0.2, 0.04, 0);
  pivot.rotation.z = Math.PI / 3; // tube raised 60°
  part(k, pivot, barrelGeo(0.055, 0.42), k.metal, [0, 0, 0], { name: 'barrel' });
  k.root.add(pivot);
  hands(k, k.root, [0.06, 0.28, 0.06], [0.1, 0.22, -0.06]);
}

function engineer(k: Kit, ww2: boolean): void {
  const f = figure(k, k.root, { hardHat: ww2, helmet: !ww2 });
  // Shovel carried at the shoulder, blade forward and down (kept above ground).
  const tool = new THREE.Group();
  tool.position.set(-0.08, 0.44, 0.15);
  tool.rotation.z = -0.42;
  part(k, tool, barrelGeo(0.022, 0.46), k.metal, [0, 0, 0], { name: 'weapon' });
  part(k, tool, box(0.14, 0.04, 0.13), k.metal, [0.5, 0, 0], { rot: [0, 0, -0.9] }); // blade
  f.add(tool);
  hands(k, f, [0.06, 0.37, 0.15], [0.24, 0.29, 0.15]);
}

function swordsman(k: Kit): void {
  const f = figure(k, k.root, { helmet: true });
  part(k, f, box(0.4, 0.035, 0.05), k.metal, [0.34, 0.24, 0.12], { name: 'weapon' });
  part(k, f, box(0.04, 0.1, 0.04), k.dark, [0.13, 0.24, 0.12]); // crossguard
  part(k, f, new THREE.CylinderGeometry(0.15, 0.15, 0.035, 6), k.light, [0.16, 0.22, -0.16], {
    rot: [0, 0, Math.PI / 2],
    edges: true,
    name: 'shield',
  });
  hands(k, f, [0.1, 0.24, 0.12], [0.13, 0.22, -0.14]);
}

function spearman(k: Kit): void {
  const f = figure(k, k.root, { helmet: true });
  const spear = new THREE.Group();
  spear.position.set(-0.2, 0.2, 0.1);
  spear.rotation.z = 0.12;
  part(k, spear, barrelGeo(0.018, 0.95), k.metal, [0, 0, 0], { name: 'weapon' });
  const tip = new THREE.ConeGeometry(0.045, 0.13, 4);
  tip.rotateZ(-Math.PI / 2);
  part(k, spear, tip, k.metal, [1.0, 0, 0]);
  f.add(spear);
  hands(k, f, [0.06, 0.22, 0.1], [0.28, 0.25, 0.1]);
}

function archer(k: Kit): void {
  const f = figure(k, k.root, {});
  const bow = new THREE.TorusGeometry(0.26, 0.026, 4, 10, Math.PI);
  bow.rotateZ(-Math.PI / 2); // arc bulges forward (+X), limbs up/down
  part(k, f, bow, k.metal, [0.22, 0.3, 0], { name: 'weapon' });
  hands(k, f, [0.48, 0.3, 0], [0.12, 0.3, 0]);
}

/** Boxy horse (faces +X), added to `parent`. */
function horse(k: Kit, parent: THREE.Object3D, pos: V3 = [0, 0, 0], scale = 1): THREE.Group {
  const h = new THREE.Group();
  h.position.set(...pos);
  h.scale.setScalar(scale);
  part(k, h, box(0.56, 0.22, 0.26), k.light, [0, 0.34, 0], { edges: true, name: 'horse' });
  part(k, h, box(0.16, 0.24, 0.14), k.light, [0.3, 0.5, 0]); // neck + head
  part(k, h, box(0.18, 0.1, 0.13), k.light, [0.38, 0.58, 0]); // muzzle
  for (const [x, z] of [
    [0.2, 0.09],
    [0.2, -0.09],
    [-0.2, 0.09],
    [-0.2, -0.09],
  ] as const) {
    part(k, h, new THREE.CylinderGeometry(0.045, 0.045, 0.24, 6), k.dark, [x, 0.12, z]);
  }
  parent.add(h);
  return h;
}

/** Gold crown ring with points, sized for a figure's head. */
function crown(k: Kit, parent: THREE.Object3D, y: number): void {
  const c = new THREE.Group();
  c.name = 'crown';
  c.position.y = y;
  part(k, c, new THREE.CylinderGeometry(0.13, 0.12, 0.07, 8, 1, true), k.gold, [0, 0, 0]);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    part(k, c, new THREE.ConeGeometry(0.035, 0.09, 4), k.gold, [
      Math.cos(a) * 0.12,
      0.075,
      Math.sin(a) * 0.12,
    ]);
  }
  parent.add(c);
}

function horseman(k: Kit, o: { crown?: boolean } = {}): void {
  const h = horse(k, k.root);
  const rider = figure(k, h, { helmet: !o.crown, scale: 0.8, y: 0.44 });
  part(k, rider, barrelGeo(0.016, 0.7), k.metal, [0.05, 0.28, 0.14], { name: 'weapon' }); // lance
  hands(k, rider, [0.12, 0.28, 0.14]);
  if (o.crown) crown(k, rider, 0.66);
}

// ── Vehicles & guns ──

function tank(k: Kit): void {
  part(k, k.root, box(0.78, 0.22, 0.5), k.body, [0, 0.22, 0], { edges: true, name: 'hull' });
  for (const z of [0.29, -0.29]) part(k, k.root, box(0.84, 0.18, 0.14), k.dark, [0, 0.1, z]);
  part(k, k.root, new THREE.CylinderGeometry(0.22, 0.25, 0.18, 6), k.light, [-0.04, 0.42, 0], {
    edges: true,
    name: 'turret',
  });
  part(k, k.root, barrelGeo(0.045, 0.56), k.metal, [0.14, 0.43, 0], { name: 'barrel' });
}

function atGun(k: Kit): void {
  part(k, k.root, box(0.06, 0.3, 0.48), k.body, [0.08, 0.3, 0], { edges: true, name: 'shield' });
  part(k, k.root, barrelGeo(0.038, 0.72), k.metal, [0.02, 0.3, 0], { name: 'barrel' });
  for (const z of [0.25, -0.25]) part(k, k.root, wheelGeo(0.14, 0.07), k.dark, [-0.02, 0.14, z]);
  part(k, k.root, box(0.5, 0.05, 0.07), k.light, [-0.3, 0.1, 0.08], { rot: [0, 0.25, 0] });
  part(k, k.root, box(0.5, 0.05, 0.07), k.light, [-0.3, 0.1, -0.08], { rot: [0, -0.25, 0] });
}

function lav(k: Kit): void {
  part(k, k.root, box(0.78, 0.26, 0.44), k.body, [0, 0.28, 0], { edges: true, name: 'hull' });
  for (const x of [0.25, -0.25])
    for (const z of [0.24, -0.24]) part(k, k.root, wheelGeo(0.13, 0.08), k.dark, [x, 0.13, z]);
  part(k, k.root, box(0.26, 0.13, 0.24), k.light, [-0.04, 0.47, 0], {
    edges: true,
    name: 'turret',
  });
  part(k, k.root, barrelGeo(0.026, 0.36), k.metal, [0.08, 0.48, 0], { name: 'barrel' });
}

function motorArtillery(k: Kit): void {
  part(k, k.root, box(0.26, 0.26, 0.42), k.light, [0.33, 0.3, 0], { edges: true, name: 'cab' });
  part(k, k.root, box(0.56, 0.14, 0.44), k.body, [-0.1, 0.24, 0], { edges: true, name: 'bed' });
  for (const x of [0.32, -0.08, -0.3])
    for (const z of [0.23, -0.23]) part(k, k.root, wheelGeo(0.11, 0.07), k.dark, [x, 0.11, z]);
  part(k, k.root, new THREE.CylinderGeometry(0.1, 0.12, 0.1, 6), k.metal, [-0.12, 0.36, 0]);
  const pivot = new THREE.Group();
  pivot.position.set(-0.12, 0.4, 0);
  pivot.rotation.z = Math.PI / 7; // raised for indirect fire
  part(k, pivot, barrelGeo(0.05, 0.9), k.metal, [0, 0, 0], { name: 'barrel' });
  k.root.add(pivot);
}

function catapult(k: Kit): void {
  part(k, k.root, box(0.62, 0.08, 0.36), k.body, [0, 0.14, 0], { edges: true, name: 'frame' });
  for (const x of [0.22, -0.22])
    for (const z of [0.2, -0.2]) part(k, k.root, wheelGeo(0.1, 0.05), k.dark, [x, 0.1, z]);
  for (const z of [0.12, -0.12]) part(k, k.root, box(0.07, 0.34, 0.06), k.light, [0.06, 0.34, z]);
  const arm = new THREE.Group();
  arm.position.set(0.06, 0.46, 0);
  arm.rotation.z = Math.PI - 0.6; // throwing arm cocked back
  part(k, arm, barrelGeo(0.04, 0.62), k.metal, [0, 0, 0], { name: 'barrel' });
  part(k, arm, box(0.16, 0.07, 0.18), k.metal, [0.62, 0.03, 0]); // cup
  k.root.add(arm);
}

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

// ── Army commander clusters (strategic map) ──────────────────────────────────

export type ArmyCategory = 'infantry' | 'armor' | 'artillery' | 'cavalry';

export function armyCategory(typeId: string): ArmyCategory {
  const t = unitType(typeId);
  if (t.unitClass === 'cavalry') return 'cavalry';
  if (t.attackType === 'indirect') return 'artillery';
  if (t.unitClass === 'vehicle') return 'armor';
  return 'infantry';
}

export const MAX_ESCORTS = 3;

/**
 * Which unit models escort the commander: a reduced, representative sample.
 * Each category present gets one slot (its most common type), biggest category
 * first; leftover slots go to the next most common types, so a pure-infantry
 * army still shows variety (e.g. rifle + MG + bazooka) rather than clones.
 */
export function armyEscorts(typeIds: string[]): string[] {
  const count = new Map<string, number>();
  for (const id of typeIds) count.set(id, (count.get(id) ?? 0) + 1);
  // Most common first; ties broken by roster order for stability.
  const types = [...count.keys()].sort(
    (a, b) => count.get(b)! - count.get(a)! || typeIds.indexOf(a) - typeIds.indexOf(b),
  );
  const byCategory = new Map<ArmyCategory, number>();
  for (const id of typeIds)
    byCategory.set(armyCategory(id), (byCategory.get(armyCategory(id)) ?? 0) + 1);
  const categories = [...byCategory.keys()].sort((a, b) => byCategory.get(b)! - byCategory.get(a)!);

  const picks: string[] = [];
  for (const c of categories) {
    const rep = types.find((id) => armyCategory(id) === c);
    if (rep && picks.length < MAX_ESCORTS) picks.push(rep);
  }
  for (const id of types) {
    if (picks.length >= MAX_ESCORTS) break;
    if (!picks.includes(id)) picks.push(id);
  }
  return picks;
}

function starGeo(outer: number, inner: number, depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.rotateX(-Math.PI / 2); // lie flat, face up
  return g;
}

/** Half-cylinder canvas cover (dome up), axis along X. */
function coverGeo(radius: number, length: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, 8, 1, false, 0, Math.PI);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** WW2 command vehicle: covered truck with a gold star on the hood. */
function commandTruck(k: Kit, parent: THREE.Object3D): void {
  const t = new THREE.Group();
  t.name = 'commander';
  part(k, t, box(0.18, 0.14, 0.36), k.body, [0.5, 0.24, 0], { name: 'hood' });
  part(k, t, box(0.24, 0.3, 0.4), k.body, [0.3, 0.32, 0], { name: 'cab' });
  part(k, t, box(0.56, 0.1, 0.42), k.body, [-0.12, 0.22, 0], { name: 'bed' });
  part(k, t, coverGeo(0.21, 0.56), k.body, [-0.12, 0.27, 0], { name: 'cover' });
  for (const x of [0.42, -0.22])
    for (const z of [0.22, -0.22]) part(k, t, wheelGeo(0.11, 0.07), k.dark, [x, 0.11, z]);
  const star = part(k, t, starGeo(0.1, 0.042, 0.015), k.gold, [0.5, 0.315, 0], { name: 'star' });
  star.rotation.y = -Math.PI / 2; // one point toward the front
  parent.add(t);
}

/** Medieval baggage: a covered horse-cart. */
function horseCart(k: Kit, parent: THREE.Object3D, pos: V3): void {
  const c = new THREE.Group();
  c.name = 'cart';
  c.position.set(...pos);
  part(k, c, box(0.46, 0.08, 0.34), k.body, [0, 0.24, 0], { name: 'bed' });
  part(k, c, coverGeo(0.17, 0.46), k.body, [0, 0.28, 0], { name: 'cover' });
  for (const z of [0.2, -0.2]) part(k, c, wheelGeo(0.14, 0.05), k.dark, [-0.02, 0.14, z]);
  for (const z of [0.08, -0.08]) part(k, c, barrelGeo(0.015, 0.36), k.body, [0.23, 0.22, z]); // shafts
  horse(k, c, [0.62, 0, 0], 0.75);
  parent.add(c);
}

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

/** Same materials, different root (so a sub-model can be positioned as a group). */
function makeKitFrom(k: Kit, root: THREE.Group): Kit {
  return { ...k, root };
}
