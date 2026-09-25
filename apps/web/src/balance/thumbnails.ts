// ── Unit thumbnails: one shared offscreen WebGL renderer → cached data URLs ──
// Each unit model is built, framed, rendered once to a small canvas, snapshotted
// to a PNG data URL and disposed. Without WebGL (jsdom, blocked GPU) every call
// returns null and the card shows a text badge instead.

import * as THREE from 'three';
import { buildUnitModel } from '../render/unitModels/index.ts';

const SIZE = 160;

let renderer: THREE.WebGLRenderer | null = null;
let unavailable = false;
const cache = new Map<string, string>();

function getRenderer(): THREE.WebGLRenderer | null {
  if (renderer || unavailable) return renderer;
  try {
    const canvas = document.createElement('canvas');
    // Probe first: three logs noisily when context creation fails.
    const probe = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!probe) throw new Error('no WebGL');
    renderer = new THREE.WebGLRenderer({
      canvas,
      context: probe as WebGL2RenderingContext,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    renderer.setClearColor(0x000000, 0);
  } catch {
    unavailable = true;
    renderer = null;
  }
  return renderer;
}

function disposeObject(root: THREE.Object3D): void {
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => mats.add(x));
    else if (mat) mats.add(mat);
  });
  for (const mat of mats) mat.dispose();
}

/** True once a thumbnail render has failed for lack of WebGL. */
export function thumbnailsUnavailable(): boolean {
  return unavailable;
}

/**
 * PNG data URL of the unit model in `color`, or null without WebGL.
 * Cached per typeId + colour.
 */
export function unitThumbnail(typeId: string, color: number): string | null {
  const key = `${typeId}:${color.toString(16)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = getRenderer();
  if (!r) return null;
  let model: THREE.Group | null = null;
  try {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0x9fdcff, 0x020814, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(3, 6, 4);
    scene.add(sun);
    model = buildUnitModel(typeId, { color, opacity: 1 });
    scene.add(model);

    const box = new THREE.Box3().setFromObject(model);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(0.05, sphere.radius);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(15))) * 1.05;
    // Three-quarter view from the front-left (models face +X).
    const dir = new THREE.Vector3(1.1, 0.75, 1).normalize();
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.lookAt(sphere.center);

    r.render(scene, camera);
    const url = r.domElement.toDataURL('image/png');
    cache.set(key, url);
    return url;
  } catch {
    return null;
  } finally {
    if (model) disposeObject(model);
  }
}

/** Test hook: forget the renderer and cache. */
export function resetThumbnails(): void {
  renderer?.dispose();
  renderer = null;
  unavailable = false;
  cache.clear();
}
