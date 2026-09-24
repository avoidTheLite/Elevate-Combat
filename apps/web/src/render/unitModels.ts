// ── Unit models: chunky geometric primitives, "chibi" proportions ────────────
// Every model faces +X (the scene rotates it to the unit's facing). Figures get
// a big head, a short stubby body and ball hands that sit on their weapon;
// vehicles are short and chunky with oversized turrets and cylinder barrels.
// Team colour is the body; weapons are a neutral light metal.

import * as THREE from 'three';

export interface ModelOptions {
  color: number;
  opacity: number;
}

const NEUTRAL = 0xdfe8ee; // weapons / metal
const DARK = 0x3a4652; // treads, wheels, bases

interface Kit {
  root: THREE.Group;
  body: THREE.Material;
  light: THREE.Material;
  skin: THREE.Material;
  metal: THREE.Material;
  dark: THREE.Material;
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
  const tint = (t: number): number =>
    new THREE.Color(o.color).lerp(new THREE.Color(0xffffff), t).getHex();
  return {
    root: new THREE.Group(),
    body: lambert(o.color, o.opacity),
    light: lambert(tint(0.35), o.opacity),
    skin: lambert(tint(0.6), o.opacity, 0.25),
    metal: lambert(NEUTRAL, o.opacity, 0.3),
    dark: lambert(DARK, o.opacity, 0.2),
    edge: new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55 * o.opacity,
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
  if (opts.edges) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), k.edge));
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

function horseman(k: Kit): void {
  const horse = new THREE.Group();
  part(k, horse, box(0.56, 0.22, 0.26), k.light, [0, 0.34, 0], { edges: true, name: 'horse' });
  part(k, horse, box(0.16, 0.24, 0.14), k.light, [0.3, 0.5, 0]); // neck + head
  part(k, horse, box(0.18, 0.1, 0.13), k.light, [0.38, 0.58, 0]); // muzzle
  for (const [x, z] of [
    [0.2, 0.09],
    [0.2, -0.09],
    [-0.2, 0.09],
    [-0.2, -0.09],
  ] as const) {
    part(k, horse, new THREE.CylinderGeometry(0.045, 0.045, 0.24, 6), k.dark, [x, 0.12, z]);
  }
  k.root.add(horse);
  const rider = figure(k, horse, { helmet: true, scale: 0.8, y: 0.44 });
  part(k, rider, barrelGeo(0.016, 0.7), k.metal, [0.05, 0.28, 0.14], { name: 'weapon' }); // lance
  hands(k, rider, [0.12, 0.28, 0.14]);
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
