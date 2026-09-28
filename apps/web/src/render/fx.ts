// ── three.js runtime for attack effects ──────────────────────────────────────
// Minimalist geometric "training simulation" look: glowing points, wireframe
// shells, flat hex rings and line shards. Only neutral highlight colours
// (yellow / amber / orange) are used — team colours stay reserved for units.

import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { arcHeight } from '@iron-ridge/engine';
import type { AttackFx, FxLabel } from './effects.ts';
import { BURST_GAP, LABEL_TIME, flightTime } from './effects.ts';
import { topY } from './spec.ts';

export const FX_YELLOW = 0xffe066;
export const FX_AMBER = 0xffc040;
export const FX_ORANGE = 0xffa030;
export const FX_CORE = 0xfff4c8;
export const FX_DUST = 0xd8cc98;

/** Anything the scene animates for a while and then removes. */
export interface ActiveEffect {
  /** Advance to scene time `t` (seconds). Returns false when finished. */
  update: (t: number) => boolean;
  dispose: () => void;
}

export interface FxEnv {
  group: THREE.Group;
  /** Top-centre of a cell in the world group's local space. */
  cellPos: (key: string) => THREE.Vector3;
  glow: THREE.Texture;
}

const LEVEL = topY(1) - topY(0);
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const easeOut = (x: number): number => 1 - (1 - x) * (1 - x);

function additive(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function lineMat(color: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function glowSprite(env: FxEnv, color: number, size: number): THREE.Sprite {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: env.glow,
      color,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  s.scale.setScalar(size);
  return s;
}

function hexRing(inner: number, outer: number, color: number): THREE.Mesh {
  const g = new THREE.RingGeometry(inner, outer, 6);
  g.rotateX(-Math.PI / 2);
  g.rotateY(Math.PI / 6);
  return new THREE.Mesh(g, additive(color, 0.9));
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose?.();
  });
  root.parent?.remove(root);
}

/** A group that lives from `start` for `life` seconds, driven by `step(k)` with k∈[0,1]. */
function timed(
  env: FxEnv,
  start: number,
  life: number,
  build: (g: THREE.Group) => (k: number) => void,
): ActiveEffect {
  const g = new THREE.Group();
  g.visible = false;
  env.group.add(g);
  const step = build(g);
  return {
    update: (t) => {
      const k = (t - start) / life;
      if (k < 0) return true;
      if (k >= 1) return false;
      g.visible = true;
      step(k);
      return true;
    },
    dispose: () => disposeTree(g),
  };
}

// ── Flight paths ──

function pathPoint(fx: AttackFx, a: THREE.Vector3, b: THREE.Vector3, k: number): THREE.Vector3 {
  const lvlA = (a.y - topY(0)) / LEVEL + fx.eye;
  const lvlB = (b.y - topY(0)) / LEVEL + 0.45;
  const lvl =
    fx.style.projectile === 'lob'
      ? arcHeight(lvlA, lvlB, fx.distance, k)
      : lvlA + (lvlB - lvlA) * k;
  return new THREE.Vector3(a.x + (b.x - a.x) * k, topY(0) + lvl * LEVEL, a.z + (b.z - a.z) * k);
}

function projectile(env: FxEnv, fx: AttackFx, start: number, jitter: THREE.Vector3): ActiveEffect {
  const a = env.cellPos(fx.from);
  const b = env.cellPos(fx.to).add(jitter);
  const dur = flightTime(fx.style.projectile, fx.distance);
  const kind = fx.style.projectile;
  return timed(env, start, dur, (g) => {
    const color = kind === 'shell' || kind === 'lob' ? FX_ORANGE : FX_YELLOW;
    const head = new THREE.Group();
    if (kind === 'arrow') {
      const dir = b.clone().sub(a).normalize().multiplyScalar(0.28);
      const geo = new THREE.BufferGeometry().setFromPoints([dir.clone().negate(), dir]);
      head.add(new THREE.Line(geo, lineMat(FX_YELLOW)));
      head.add(glowSprite(env, FX_YELLOW, 0.35));
    } else {
      const r = kind === 'lob' ? 0.16 : kind === 'shell' ? 0.13 : 0.07;
      head.add(new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), additive(FX_CORE)));
      head.add(glowSprite(env, color, r * (kind === 'bullet' ? 7 : 9)));
    }
    g.add(head);
    // Short fading trail.
    const trailPts = Array.from({ length: 8 }, () => a.clone());
    const trailGeo = new THREE.BufferGeometry().setFromPoints(trailPts);
    const trailMat = lineMat(color);
    trailMat.opacity = 0.55;
    g.add(new THREE.Line(trailGeo, trailMat));
    return (k) => {
      const p = pathPoint(fx, a, b, kind === 'lob' ? k : easeOut(k) * 0.35 + k * 0.65);
      head.position.copy(p);
      trailPts.pop();
      trailPts.unshift(p.clone());
      trailGeo.setFromPoints(trailPts);
    };
  });
}

// ── Impacts ──

function explosion(env: FxEnv, fx: AttackFx, at: THREE.Vector3, start: number): ActiveEffect[] {
  const s = fx.style.big ? 1.5 : 1;
  const ringTo = fx.splashRadius > 0 ? 0.9 + fx.splashRadius * Math.sqrt(3) : 1.1;
  return [
    // Core flash.
    timed(env, start, 0.28, (g) => {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5 * s, 1), additive(FX_CORE));
      const glow = glowSprite(env, FX_AMBER, 3.2 * s);
      g.add(m, glow);
      g.position.copy(at).add(new THREE.Vector3(0, 0.3, 0));
      return (k) => {
        m.scale.setScalar(0.3 + easeOut(k) * 0.9);
        (m.material as THREE.MeshBasicMaterial).opacity = 1 - k;
        glow.material.opacity = 1 - k;
      };
    }),
    // Expanding wireframe shell.
    timed(env, start, 0.7, (g) => {
      const shell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.6 * s, 0),
        new THREE.MeshBasicMaterial({
          color: FX_ORANGE,
          wireframe: true,
          transparent: true,
          depthWrite: false,
        }),
      );
      g.add(shell);
      g.position.copy(at).add(new THREE.Vector3(0, 0.35, 0));
      return (k) => {
        shell.scale.setScalar(0.4 + easeOut(k) * 1.4);
        shell.rotation.set(k * 1.6, k * 2.2, 0);
        (shell.material as THREE.MeshBasicMaterial).opacity = 1 - k;
      };
    }),
    // Ground shock ring out to the splash radius.
    timed(env, start + 0.04, 0.75, (g) => {
      const ring = hexRing(0.82, 1, FX_YELLOW);
      g.add(ring);
      g.position.copy(at).add(new THREE.Vector3(0, 0.05, 0));
      return (k) => {
        ring.scale.setScalar(0.3 + easeOut(k) * ringTo * s);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
      };
    }),
    // Radiating shards.
    timed(env, start, 0.55, (g) => {
      const n = fx.style.big ? 10 : 7;
      const shards: { line: THREE.Line; dir: THREE.Vector3 }[] = [];
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + 0.3;
        const dir = new THREE.Vector3(
          Math.cos(ang),
          0.55 + (i % 3) * 0.25,
          Math.sin(ang),
        ).normalize();
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(),
          dir.clone().multiplyScalar(0.35),
        ]);
        const line = new THREE.Line(geo, lineMat(i % 2 ? FX_YELLOW : FX_ORANGE));
        g.add(line);
        shards.push({ line, dir });
      }
      g.position.copy(at).add(new THREE.Vector3(0, 0.25, 0));
      return (k) => {
        for (const sh of shards) {
          sh.line.position.copy(sh.dir).multiplyScalar(easeOut(k) * 1.3 * s);
          (sh.line.material as THREE.LineBasicMaterial).opacity = 1 - k;
        }
      };
    }),
  ];
}

function dust(env: FxEnv, at: THREE.Vector3, start: number, seed: number): ActiveEffect[] {
  return [
    timed(env, start, 0.55, (g) => {
      const bits: { m: THREE.Mesh; v: THREE.Vector3 }[] = [];
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2 + seed;
        const v = new THREE.Vector3(
          Math.cos(ang) * 0.35,
          0.35 + (i % 2) * 0.2,
          Math.sin(ang) * 0.35,
        );
        const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.07, 0), additive(FX_DUST, 0.85));
        g.add(m);
        bits.push({ m, v });
      }
      const ring = hexRing(0.55, 0.68, FX_DUST);
      g.add(ring);
      g.position.copy(at).add(new THREE.Vector3(0, 0.05, 0));
      return (k) => {
        for (const b of bits) {
          b.m.position.copy(b.v).multiplyScalar(easeOut(k) * 1.2);
          b.m.scale.setScalar(1 + k * 1.5);
          (b.m.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k);
        }
        ring.scale.setScalar(0.4 + easeOut(k) * 0.8);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
      };
    }),
  ];
}

function slash(env: FxEnv, at: THREE.Vector3, start: number): ActiveEffect[] {
  return [
    timed(env, start, 0.45, (g) => {
      const mk = (ax: number, ay: number, bx: number, by: number, color: number): THREE.Line =>
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(ax, ay, 0),
            new THREE.Vector3(bx, by, 0),
          ]),
          lineMat(color),
        );
      const x1 = mk(-0.6, 0.15, 0.6, 1.25, FX_YELLOW);
      const x2 = mk(-0.6, 1.25, 0.6, 0.15, FX_ORANGE);
      const ring = hexRing(0.6, 0.78, FX_AMBER);
      const flash = glowSprite(env, FX_AMBER, 2.2);
      flash.position.y = 0.7;
      g.add(x1, x2, ring, flash);
      g.position.copy(at);
      return (k) => {
        const grow = clamp01(k / 0.25);
        x1.scale.setScalar(grow);
        x2.scale.setScalar(grow);
        for (const o of [x1, x2]) (o.material as THREE.LineBasicMaterial).opacity = 1 - k;
        ring.scale.setScalar(0.5 + easeOut(k) * 0.7);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k);
        flash.material.opacity = Math.max(0, 1 - k * 2.5);
      };
    }),
  ];
}

// ── Floating damage numbers ──

function label(env: FxEnv, l: FxLabel, start: number): ActiveEffect {
  const el = document.createElement('div');
  el.className = `ir-fx-label ir-fx-${l.tone}`;
  el.textContent = l.text;
  const obj = new CSS2DObject(el);
  obj.visible = false;
  // Start above the unit's name tag so the two never overlap.
  const base = env.cellPos(l.key).add(new THREE.Vector3(0, 1.75, 0));
  obj.position.copy(base);
  env.group.add(obj);
  return {
    update: (t) => {
      const k = (t - start) / LABEL_TIME;
      if (k < 0) return true;
      if (k >= 1) return false;
      obj.visible = true;
      obj.position.set(base.x, base.y + easeOut(k) * 0.9, base.z);
      el.style.opacity = String(k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
      return true;
    },
    dispose: () => {
      el.remove();
      obj.parent?.remove(obj);
    },
  };
}

/** All the pieces of one attack, scheduled from scene time `now`. */
export function createAttackEffects(env: FxEnv, fx: AttackFx, now: number): ActiveEffect[] {
  const out: ActiveEffect[] = [];
  const target = env.cellPos(fx.to);
  const single = flightTime(fx.style.projectile, fx.distance);
  for (let r = 0; r < fx.style.rounds; r++) {
    const launch = now + r * BURST_GAP;
    // Burst rounds scatter slightly around the target cell; misses land off-centre.
    const missAngle = fx.id * 2.1 + r * 1.7;
    const jitter = fx.miss
      ? new THREE.Vector3(Math.cos(missAngle) * 0.6, 0, Math.sin(missAngle) * 0.6)
      : r === 0
        ? new THREE.Vector3()
        : new THREE.Vector3(Math.cos(r * 2.4) * 0.25, 0, Math.sin(r * 2.4) * 0.25);
    if (fx.style.projectile !== 'none') out.push(projectile(env, fx, launch, jitter));
    const at = target.clone().add(jitter);
    const hit = launch + single;
    if (fx.style.impact === 'explosion') out.push(...explosion(env, fx, at, hit));
    else if (fx.style.impact === 'dust') out.push(...dust(env, at, hit, r * 1.3));
    else out.push(...slash(env, at, hit));
  }
  for (const l of fx.labels) out.push(label(env, l, now + fx.flight));
  return out;
}
