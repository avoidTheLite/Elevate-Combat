// ── Isometric 3D hex renderer (three.js) ─────────────────────────────────────
// Imperative scene owned by a React wrapper. Neon/Tron "training simulation"
// look from the core-mechanics doc: dark void, glowing cyan terrain outlines,
// geometric unit silhouettes, colour-coded firing arcs.
//
// Camera: true isometric orthographic view. WASD / arrow keys pan, Q/E rotate,
// mouse wheel zooms, right- or middle-drag pans, F toggles the behind-unit
// firing view when a trajectory is shown.

import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import {
  arcHeight,
  hexCorner,
  hexDistance,
  hexToWorld,
  parseKey,
  DIRECTIONS,
} from '@iron-ridge/engine';
import type { CellSpec, SceneSpec, TokenSpec } from './spec.ts';
import { TEAM_COLOR, topY } from './spec.ts';

const FILL = [
  0x05071c, 0x07112c, 0x091d3c, 0x0b2a4b, 0x0d3958, 0x104a64, 0x15606e, 0x1e7a76, 0x6a4a0c,
];
const LINE = [
  0x2c2c80, 0x2b4198, 0x2a5eb2, 0x2a7ec8, 0x22a0dc, 0x20c2e8, 0x44e2e0, 0x9cfff0, 0xffc030,
];
const ISO_ELEVATION = Math.atan(1 / Math.SQRT2); // 35.264°
const STATUS_COLOR = { clear: 0x33ff88, marginal: 0xffb020, blocked: 0xff3344 } as const;

export interface SceneHandlers {
  onHover?: (key: string | null) => void;
  onClick?: (key: string, button: number) => void;
}

interface TokenObj {
  group: THREE.Group;
  body: THREE.Group;
  label: CSS2DObject;
  labelEl: HTMLDivElement;
  target: THREE.Vector3;
  kindSig: string;
}

function mixColor(a: number, b: number, t: number): THREE.Color {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

let glowTexture: THREE.Texture | null = null;
function getGlowTexture(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

export class HexScene {
  private renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private world = new THREE.Group();
  private ortho: THREE.OrthographicCamera;
  private persp: THREE.PerspectiveCamera;
  private container: HTMLElement;
  private handlers: SceneHandlers = {};

  private terrainId = '';
  private cells: CellSpec[] = [];
  private cellIndex = new Map<string, number>();
  private terrainMesh: THREE.InstancedMesh | null = null;
  private outline: THREE.LineSegments | null = null;
  private overlayMesh: THREE.InstancedMesh | null = null;
  private fortMesh: THREE.InstancedMesh | null = null;
  private borderGroup = new THREE.Group();
  private fxGroup = new THREE.Group();
  private tokens = new Map<string, TokenObj>();
  private tokenGroup = new THREE.Group();
  private selectionRing: THREE.Mesh;
  private hoverRing: THREE.Mesh;
  private lineMaterials: LineMaterial[] = [];

  // Camera state
  private target = new THREE.Vector3();
  private targetGoal = new THREE.Vector3();
  private azimuth = Math.PI / 4;
  private azimuthGoal = Math.PI / 4;
  private viewSize = 30;
  private viewSizeGoal = 30;
  private keys = new Set<string>();
  private fireView: SceneSpec['fireView'] = null;
  private fireEnabled = false;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerDirty = false;
  private dragging: { x: number; y: number; button: number; moved: boolean } | null = null;
  private hoverKey: string | null = null;
  private lastTime = performance.now();
  private elapsed = 0;
  private resizeObs: ResizeObserver;
  private disposed = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000810);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.tabIndex = 0;
    // Touch drags pan the camera instead of scrolling the page.
    this.renderer.domElement.style.touchAction = 'none';

    this.labels = new CSS2DRenderer();
    this.labels.domElement.style.position = 'absolute';
    this.labels.domElement.style.inset = '0';
    this.labels.domElement.style.pointerEvents = 'none';
    container.appendChild(this.labels.domElement);

    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 1000);
    this.persp = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);

    this.scene.add(new THREE.HemisphereLight(0x9fdcff, 0x020814, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(30, 60, 20);
    this.scene.add(sun);
    this.scene.add(this.world);
    this.world.add(this.borderGroup, this.fxGroup, this.tokenGroup);

    const ringGeo = new THREE.RingGeometry(0.72, 0.95, 6);
    ringGeo.rotateX(-Math.PI / 2);
    ringGeo.rotateY(Math.PI / 6);
    this.selectionRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffff44,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    );
    this.selectionRing.renderOrder = 10;
    this.selectionRing.visible = false;
    this.hoverRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.55,
        depthTest: false,
      }),
    );
    this.hoverRing.renderOrder = 9;
    this.hoverRing.visible = false;
    this.world.add(this.selectionRing, this.hoverRing);

    this.bindInput();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setHandlers(h: SceneHandlers): void {
    this.handlers = h;
  }

  // ── Public API ──

  update(spec: SceneSpec, selectedKey: string | null): void {
    this.world.rotation.y = spec.worldRotation;
    const fresh = spec.terrainId !== this.terrainId;
    this.cells = spec.cells;
    if (fresh) {
      this.buildTerrain(spec.cells);
      this.terrainId = spec.terrainId;
      this.frameAll();
    }
    this.paintTerrain(spec.cells);
    this.buildOverlays(spec);
    this.buildForts(spec.cells);
    this.buildBorders(spec);
    this.buildTokens(spec.tokens);
    this.buildFx(spec);
    this.fireView = spec.fireView;
    if (!spec.fireView) this.fireEnabled = false;

    if (selectedKey && this.cellIndex.has(selectedKey)) {
      const p = this.cellPos(selectedKey);
      this.selectionRing.position.set(p.x, p.y + 0.03, p.z);
      this.selectionRing.visible = true;
    } else this.selectionRing.visible = false;
  }

  focus(key: string): void {
    if (!this.cellIndex.has(key)) return;
    const p = this.cellPos(key);
    const w = p.clone().applyMatrix4(this.world.matrixWorld);
    this.targetGoal.set(w.x, 0, w.z);
  }

  /** Client-pixel position of a cell's top face (used by smoke tests / tooling). */
  projectKey(key: string): { x: number; y: number } | null {
    if (!this.cellIndex.has(key)) return null;
    this.world.updateMatrixWorld(true);
    const p = this.cellPos(key).applyMatrix4(this.world.matrixWorld).project(this.activeCamera());
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  rotate(steps: number): void {
    this.azimuthGoal += (steps * Math.PI) / 4;
  }

  zoom(factor: number): void {
    this.viewSizeGoal = THREE.MathUtils.clamp(this.viewSizeGoal * factor, 6, 400);
  }

  toggleFireView(): void {
    if (this.fireView) this.fireEnabled = !this.fireEnabled;
  }

  isFireView(): boolean {
    return this.fireEnabled && this.fireView !== null;
  }

  frameAll(): void {
    if (!this.cells.length) return;
    this.world.updateMatrixWorld(true);
    const pts = this.cells.map((c) => {
      const w = hexToWorld(c);
      return new THREE.Vector3(w.x, topY(c.h), w.z).applyMatrix4(this.world.matrixWorld);
    });
    const box = new THREE.Box3().setFromPoints(pts);
    const centre = box.getCenter(new THREE.Vector3());
    this.targetGoal.set(centre.x, 0, centre.z);
    this.target.copy(this.targetGoal);
    this.azimuth = this.azimuthGoal;
    // Project onto the camera's screen axes to find the extent that must fit.
    const a = this.azimuth;
    const e = ISO_ELEVATION;
    const right = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    const up = new THREE.Vector3(
      -Math.sin(e) * Math.sin(a),
      Math.cos(e),
      -Math.sin(e) * Math.cos(a),
    );
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      const d = p.clone().sub(this.target);
      const x = d.dot(right);
      const y = d.dot(up);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    // Recentre on the projected box so the map sits in the middle of the view.
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    // Move the target along the ground plane so the screen-space centre lines up.
    const fwdGround = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a));
    this.targetGoal
      .add(right.clone().multiplyScalar(cx))
      .add(fwdGround.multiplyScalar(cy / Math.sin(e)));
    this.target.copy(this.targetGoal);
    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    const need = Math.max(maxY - minY, (maxX - minX) / aspect) * 1.08;
    this.viewSizeGoal = THREE.MathUtils.clamp(need, 8, 400);
    this.viewSize = this.viewSizeGoal;
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObs.disconnect();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.renderer.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
    });
    this.container.innerHTML = '';
  }

  // ── Terrain ──

  private buildTerrain(cells: CellSpec[]): void {
    if (this.terrainMesh) {
      this.world.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
    }
    if (this.outline) {
      this.world.remove(this.outline);
      this.outline.geometry.dispose();
    }
    this.cellIndex.clear();
    cells.forEach((c, i) => this.cellIndex.set(c.key, i));

    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, false);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x010408 });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, cells.length));
    const m = new THREE.Matrix4();
    cells.forEach((c, i) => {
      const w = hexToWorld(c);
      m.makeScale(0.985, topY(c.h), 0.985);
      m.setPosition(w.x, 0, w.z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, new THREE.Color(FILL[c.h] ?? FILL[0]));
    });
    mesh.count = cells.length;
    mesh.instanceMatrix.needsUpdate = true;
    this.terrainMesh = mesh;
    this.world.add(mesh);

    // Glowing top outlines (one line-segment soup, coloured by height).
    const pos: number[] = [];
    const col: number[] = [];
    const corners = Array.from({ length: 6 }, (_, i) => hexCorner(i, 0.985));
    for (const c of cells) {
      const w = hexToWorld(c);
      const y = topY(c.h) + 0.004;
      const clr = new THREE.Color(LINE[c.h] ?? LINE[0]);
      for (let i = 0; i < 6; i++) {
        const a = corners[i]!;
        const b = corners[(i + 1) % 6]!;
        pos.push(w.x + a.x, y, w.z + a.z, w.x + b.x, y, w.z + b.z);
        col.push(clr.r, clr.g, clr.b, clr.r, clr.g, clr.b);
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.outline = new THREE.LineSegments(
      lg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 }),
    );
    this.world.add(this.outline);
  }

  private paintTerrain(cells: CellSpec[]): void {
    const mesh = this.terrainMesh;
    if (!mesh) return;
    const outlineColors = this.outline?.geometry.getAttribute('color') as
      THREE.BufferAttribute | undefined;
    cells.forEach((c, i) => {
      let clr = new THREE.Color(FILL[c.h] ?? FILL[0]);
      if (c.tint !== undefined && c.tint !== null)
        clr = clr.lerp(new THREE.Color(c.tint), c.tintAmount ?? 0.25);
      if (c.dim) clr.multiplyScalar(0.35);
      mesh.setColorAt(i, clr);
      if (outlineColors) {
        const lc = new THREE.Color(LINE[c.h] ?? LINE[0]);
        if (c.dim) lc.multiplyScalar(0.3);
        for (let v = 0; v < 12; v++) outlineColors.setXYZ(i * 12 + v, lc.r, lc.g, lc.b);
      }
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (outlineColors) outlineColors.needsUpdate = true;
  }

  private cellPos(key: string): THREE.Vector3 {
    const i = this.cellIndex.get(key);
    const c = i !== undefined ? this.cells[i] : undefined;
    const hx = c ?? { ...parseKey(key), h: 0 };
    const w = hexToWorld(hx);
    return new THREE.Vector3(w.x, topY(hx.h), w.z);
  }

  private buildOverlays(spec: SceneSpec): void {
    if (this.overlayMesh) {
      this.world.remove(this.overlayMesh);
      this.overlayMesh.geometry.dispose();
      this.overlayMesh = null;
    }
    const list = spec.overlays.filter((o) => this.cellIndex.has(o.key));
    if (!list.length) return;
    const geo = new THREE.CircleGeometry(0.9, 6);
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(Math.PI / 6);
    // Additive blending: per-instance colour intensity acts as the opacity.
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4();
    list.forEach((o, i) => {
      const p = this.cellPos(o.key);
      m.makeTranslation(p.x, p.y + 0.02, p.z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, new THREE.Color(o.color).multiplyScalar(Math.min(1, o.opacity * 1.6)));
    });
    mesh.renderOrder = 2;
    this.overlayMesh = mesh;
    this.world.add(mesh);
  }

  private buildForts(cells: CellSpec[]): void {
    if (this.fortMesh) {
      this.world.remove(this.fortMesh);
      this.fortMesh.geometry.dispose();
      this.fortMesh = null;
    }
    const list = cells.filter((c) => (c.fort ?? 0) > 0);
    if (!list.length) return;
    // Sandbag ring / bunker: a low hex wall whose height shows the level.
    const geo = new THREE.CylinderGeometry(0.8, 0.88, 1, 6, 1, true);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffc34d,
      wireframe: true,
      transparent: true,
      opacity: 0.85,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4();
    list.forEach((c, i) => {
      const w = hexToWorld(c);
      m.makeScale(1, 0.12 * (c.fort ?? 1), 1);
      m.setPosition(w.x, topY(c.h), w.z);
      mesh.setMatrixAt(i, m);
    });
    this.fortMesh = mesh;
    this.world.add(mesh);
  }

  private buildBorders(spec: SceneSpec): void {
    for (const child of [...this.borderGroup.children]) {
      this.borderGroup.remove(child);
      (child as LineSegments2).geometry.dispose();
    }
    this.lineMaterials = [];
    for (const layer of spec.borders) {
      if (!layer.segments.length) continue;
      const arr: number[] = [];
      for (const s of layer.segments) arr.push(s.ax, s.y, s.az, s.bx, s.y, s.bz);
      const g = new LineSegmentsGeometry();
      g.setPositions(arr);
      const mat = new LineMaterial({
        color: layer.color,
        linewidth: layer.width,
        transparent: true,
        opacity: layer.opacity ?? 1,
        depthTest: true,
      });
      mat.resolution.set(this.container.clientWidth, this.container.clientHeight);
      this.lineMaterials.push(mat);
      const line = new LineSegments2(g, mat);
      line.renderOrder = 5;
      this.borderGroup.add(line);
    }
  }

  // ── Tokens ──

  private makeBody(t: TokenSpec): THREE.Group {
    const color = TEAM_COLOR[t.team];
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: t.spent ? 0.45 : 0.92,
    });
    const edge = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: t.spent ? 0.35 : 0.9,
    });
    const add = (geo: THREE.BufferGeometry, y: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = y;
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edge);
      e.position.y = y;
      g.add(mesh, e);
      return mesh;
    };
    switch (t.kind) {
      case 'infantry':
        add(new THREE.ConeGeometry(0.34, 0.8, 4), 0.4);
        break;
      case 'engineer':
        add(new THREE.CylinderGeometry(0.28, 0.34, 0.55, 6), 0.28);
        add(new THREE.BoxGeometry(0.5, 0.08, 0.12), 0.62);
        break;
      case 'cavalry':
        add(new THREE.OctahedronGeometry(0.42), 0.5);
        break;
      case 'vehicle':
        add(new THREE.BoxGeometry(0.62, 0.32, 0.9), 0.16);
        add(new THREE.BoxGeometry(0.38, 0.2, 0.42), 0.42);
        break;
      case 'artillery':
        add(new THREE.TetrahedronGeometry(0.42), 0.34);
        break;
      case 'army':
        add(new THREE.OctahedronGeometry(0.9), 1.0);
        break;
      case 'hq':
        add(new THREE.CylinderGeometry(0.12, 0.12, 3.2, 6), 1.6);
        add(new THREE.TorusGeometry(0.9, 0.06, 6, 6), 0.1).rotation.x = Math.PI / 2;
        break;
    }
    // Facing pointer (tactical units only).
    if (t.facing !== undefined && t.kind !== 'army' && t.kind !== 'hq') {
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.12, 0.4, 3),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      const d = hexToWorld(DIRECTIONS[t.facing]!);
      const len = Math.hypot(d.x, d.z);
      arrow.position.set((d.x / len) * 0.62, 0.12, (d.z / len) * 0.62);
      arrow.rotation.z = -Math.PI / 2;
      arrow.rotation.y = -Math.atan2(d.z, d.x);
      g.add(arrow);
    }
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    glow.scale.setScalar(t.kind === 'army' ? 3.6 : 1.8);
    glow.position.y = 0.3;
    g.add(glow);
    g.scale.setScalar(t.scale ?? 1);
    return g;
  }

  private buildTokens(tokens: TokenSpec[]): void {
    const seen = new Set<string>();
    for (const t of tokens) {
      seen.add(t.id);
      const pos = this.cellPos(t.key);
      const sig = `${t.kind}|${t.team}|${t.facing}|${t.spent}|${t.scale}`;
      let obj = this.tokens.get(t.id);
      if (!obj) {
        const group = new THREE.Group();
        const labelEl = document.createElement('div');
        labelEl.className = 'ir-token-label';
        const label = new CSS2DObject(labelEl);
        group.add(label);
        group.position.copy(pos);
        obj = { group, body: new THREE.Group(), label, labelEl, target: pos.clone(), kindSig: '' };
        this.tokenGroup.add(group);
        this.tokens.set(t.id, obj);
      }
      if (obj.kindSig !== sig) {
        obj.group.remove(obj.body);
        obj.body = this.makeBody(t);
        obj.group.add(obj.body);
        obj.kindSig = sig;
      }
      obj.target.copy(pos);
      const s = t.scale ?? 1;
      obj.label.position.set(0, (t.kind === 'army' ? 2.4 : t.kind === 'hq' ? 3.6 : 1.25) * s, 0);
      const teamHex = `#${TEAM_COLOR[t.team].toString(16).padStart(6, '0')}`;
      const hp =
        t.hpFrac !== undefined
          ? `<div class="ir-hp"><div style="width:${Math.round(t.hpFrac * 100)}%;background:${t.hpFrac > 0.5 ? '#33ff88' : t.hpFrac > 0.25 ? '#ffb020' : '#ff3344'}"></div></div>`
          : '';
      obj.labelEl.innerHTML =
        `<div class="ir-name" style="color:${teamHex};${t.selected ? 'outline:1px solid #ffff44;' : ''}">${t.label}${t.badge ? ` <span class="ir-badge">${t.badge}</span>` : ''}</div>` +
        (t.sub ? `<div class="ir-sub">${t.sub}</div>` : '') +
        hp;
      obj.labelEl.style.opacity = t.spent ? '0.55' : '1';
    }
    for (const [id, obj] of this.tokens) {
      if (seen.has(id)) continue;
      obj.group.remove(obj.label);
      obj.labelEl.remove();
      this.tokenGroup.remove(obj.group);
      this.tokens.delete(id);
    }
  }

  // ── Path + trajectory ──

  private buildFx(spec: SceneSpec): void {
    for (const child of [...this.fxGroup.children]) {
      this.fxGroup.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
    }
    if (spec.path.length > 1) {
      const pts = spec.path.map((k) => this.cellPos(k).add(new THREE.Vector3(0, 0.15, 0)));
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({ color: 0xffff66, depthTest: false }),
      );
      line.renderOrder = 11;
      this.fxGroup.add(line);
    }
    const tr = spec.trajectory;
    if (tr && this.cellIndex.has(tr.from) && this.cellIndex.has(tr.to)) {
      const a = this.cellPos(tr.from);
      const b = this.cellPos(tr.to);
      const dist = hexDistance(parseKey(tr.from), parseKey(tr.to));
      const pts: THREE.Vector3[] = [];
      const steps = 40;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        // Engine heights are in levels; convert the arc into world units.
        const lvlA = (a.y - topY(0)) / (topY(1) - topY(0)) + tr.eye;
        const lvlB = (b.y - topY(0)) / (topY(1) - topY(0)) + 0.5;
        const lvl = tr.indirect ? arcHeight(lvlA, lvlB, dist, t) : lvlA + (lvlB - lvlA) * t;
        pts.push(new THREE.Vector3(x, topY(0) + lvl * (topY(1) - topY(0)), z));
      }
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({ color: STATUS_COLOR[tr.status], depthTest: false }),
      );
      line.renderOrder = 12;
      this.fxGroup.add(line);
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 8, 8),
        new THREE.MeshBasicMaterial({ color: STATUS_COLOR[tr.status], depthTest: false }),
      );
      dot.position.copy(pts[pts.length - 1]!);
      dot.renderOrder = 12;
      this.fxGroup.add(dot);
    }
  }

  // ── Camera & input ──

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    for (const m of this.lineMaterials) m.resolution.set(w, h);
  }

  private updateCamera(dt: number): void {
    const k = 1 - Math.pow(0.0005, dt);
    // Keyboard pan (camera-relative).
    const pan = new THREE.Vector3();
    const fwd = new THREE.Vector3(-Math.sin(this.azimuth), 0, -Math.cos(this.azimuth));
    const right = new THREE.Vector3(Math.cos(this.azimuth), 0, -Math.sin(this.azimuth));
    if (this.keys.has('w') || this.keys.has('arrowup')) pan.add(fwd);
    if (this.keys.has('s') || this.keys.has('arrowdown')) pan.sub(fwd);
    if (this.keys.has('d') || this.keys.has('arrowright')) pan.add(right);
    if (this.keys.has('a') || this.keys.has('arrowleft')) pan.sub(right);
    if (pan.lengthSq() > 0)
      this.targetGoal.addScaledVector(pan.normalize(), this.viewSize * 0.9 * dt);

    this.target.lerp(this.targetGoal, k);
    this.azimuth += (this.azimuthGoal - this.azimuth) * k;
    this.viewSize += (this.viewSizeGoal - this.viewSize) * k;

    const w = this.container.clientWidth;
    const h = Math.max(1, this.container.clientHeight);
    const aspect = w / h;
    this.ortho.left = (-this.viewSize * aspect) / 2;
    this.ortho.right = (this.viewSize * aspect) / 2;
    this.ortho.top = this.viewSize / 2;
    this.ortho.bottom = -this.viewSize / 2;
    this.ortho.updateProjectionMatrix();
    const d = 200;
    this.ortho.position.set(
      this.target.x + d * Math.cos(ISO_ELEVATION) * Math.sin(this.azimuth),
      this.target.y + d * Math.sin(ISO_ELEVATION),
      this.target.z + d * Math.cos(ISO_ELEVATION) * Math.cos(this.azimuth),
    );
    this.ortho.lookAt(this.target);

    if (this.isFireView() && this.fireView) {
      this.world.updateMatrixWorld(true);
      const a = this.cellPos(this.fireView.from).applyMatrix4(this.world.matrixWorld);
      const b = this.cellPos(this.fireView.to).applyMatrix4(this.world.matrixWorld);
      const dir = b.clone().sub(a).setY(0).normalize();
      const eye = a
        .clone()
        .addScaledVector(dir, -4)
        .add(new THREE.Vector3(0, 3.2, 0));
      this.persp.position.lerp(eye, 0.25);
      this.persp.lookAt(b);
    }
  }

  private activeCamera(): THREE.Camera {
    return this.isFireView() ? this.persp : this.ortho;
  }

  private frame(): void {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.elapsed += dt;
    this.updateCamera(dt);
    const t = this.elapsed;
    for (const obj of this.tokens.values()) {
      obj.group.position.lerp(obj.target, Math.min(1, dt * 10));
      obj.body.position.y = 0.04 * Math.sin(t * 2.5 + obj.group.position.x);
    }
    (this.selectionRing.material as THREE.MeshBasicMaterial).opacity = 0.65 + 0.3 * Math.sin(t * 5);
    if (this.pointerDirty) {
      this.pointerDirty = false;
      this.pick();
    }
    const cam = this.activeCamera();
    this.renderer.render(this.scene, cam);
    this.labels.render(this.scene, cam);
  }

  private pickKey(): string | null {
    if (!this.terrainMesh) return null;
    this.raycaster.setFromCamera(this.pointer, this.activeCamera());
    const hits = this.raycaster.intersectObject(this.terrainMesh, false);
    const hit = hits[0];
    if (!hit || hit.instanceId === undefined) return null;
    return this.cells[hit.instanceId]?.key ?? null;
  }

  private pick(): void {
    const key = this.pickKey();
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      if (key) {
        const p = this.cellPos(key);
        this.hoverRing.position.set(p.x, p.y + 0.025, p.z);
        this.hoverRing.visible = true;
      } else this.hoverRing.visible = false;
      this.handlers.onHover?.(key);
    }
  }

  private setPointer(e: PointerEvent | MouseEvent): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    this.pointerDirty = true;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      this.keys.add(k);
      if (k.startsWith('arrow')) e.preventDefault();
    }
    if (k === 'q') this.rotate(-1);
    if (k === 'e') this.rotate(1);
    if (k === 'f') this.toggleFireView();
    if (k === 'r') this.frameAll();
    if (k === '=' || k === '+') this.zoom(0.85);
    if (k === '-') this.zoom(1.18);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private onBlur = (): void => {
    this.keys.clear();
  };

  private bindInput(): void {
    const el = this.renderer.domElement;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(e.deltaY > 0 ? 1.12 : 0.89);
      },
      { passive: false },
    );
    el.addEventListener('pointerdown', (e) => {
      this.dragging = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      this.setPointer(e);
      const d = this.dragging;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 5) d.moved = true;
      if (d.moved && (d.button === 1 || d.button === 2 || d.button === 0)) {
        // Drag to pan (world units per pixel from the ortho frustum).
        const upp = this.viewSize / Math.max(1, this.container.clientHeight);
        const right = new THREE.Vector3(Math.cos(this.azimuth), 0, -Math.sin(this.azimuth));
        const fwd = new THREE.Vector3(-Math.sin(this.azimuth), 0, -Math.cos(this.azimuth));
        this.targetGoal.addScaledVector(right, -dx * upp);
        this.targetGoal.addScaledVector(fwd, (dy * upp) / Math.sin(ISO_ELEVATION));
        this.target.copy(this.targetGoal);
        d.x = e.clientX;
        d.y = e.clientY;
      }
    });
    el.addEventListener('pointerup', (e) => {
      const d = this.dragging;
      this.dragging = null;
      el.releasePointerCapture(e.pointerId);
      if (d && !d.moved) {
        this.setPointer(e);
        const key = this.pickKey();
        if (key) this.handlers.onClick?.(key, e.button);
        else if (e.button === 2) this.handlers.onClick?.('', 2);
      }
    });
    el.addEventListener('pointerleave', () => {
      this.hoverKey = null;
      this.hoverRing.visible = false;
      this.handlers.onHover?.(null);
    });
  }
}

// Re-export for callers that need the same palette in HUD legends.
export const HEIGHT_LINE_COLORS = LINE;
export const HEIGHT_FILL_COLORS = FILL;
export { mixColor };
