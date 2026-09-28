import * as THREE from 'three';
import type { Kit, V3 } from './types.ts';

/** Add a mesh at `pos` to `parent`; optional white edge outline for major parts. */
export function part(
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
export function barrelGeo(radius: number, length: number, segments = 8): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, segments);
  g.rotateZ(-Math.PI / 2);
  g.translate(length / 2, 0, 0);
  return g;
}

/** Wheel: cylinder whose axis runs along Z. */
export function wheelGeo(radius: number, width: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, width, 8);
  g.rotateX(Math.PI / 2);
  return g;
}

export const box = (x: number, y: number, z: number): THREE.BufferGeometry =>
  new THREE.BoxGeometry(x, y, z);
export const ball = (r: number): THREE.BufferGeometry => new THREE.IcosahedronGeometry(r, 1);

export function starGeo(outer: number, inner: number, depth: number): THREE.BufferGeometry {
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
export function coverGeo(radius: number, length: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, 8, 1, false, 0, Math.PI);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** Pitched-roof prism, ridge along Z, with closed (boxed) gable ends; eaves at y = 0. */
export function gableRoofGeo(width: number, rise: number, length: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0);
  shape.lineTo(width / 2, 0);
  shape.lineTo(0, rise);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false });
  g.translate(0, 0, -length / 2);
  return g;
}
