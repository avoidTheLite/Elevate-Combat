import { describe, expect, it } from 'vitest';
import type { GameState } from '@iron-ridge/engine';
import {
  apply,
  buildWorld,
  clusterSize,
  generateTerrain,
  hexToWorld,
  mainBoundary,
  createGame,
  defaultSettings,
  mainNeighbors,
  worldOf,
} from '@iron-ridge/engine';
import { buildStrategicScene, buildTacticalScene, mainOutline } from './buildScene.ts';
import type { Segment3, TokenSpec } from './spec.ts';
import { topY } from './spec.ts';
import { BASIC_FILL, CAPTURE_COLOR, HEIGHT_FILL, OVERLAYS } from './overlays.ts';

const UI = {
  selectedMain: null,
  selectedArmy: null,
  selectedUnit: null,
  hoverCell: null,
  deployPick: null,
  placingFort: false,
};

function battleState(): GameState {
  let s = createGame({
    ...defaultSettings(),
    grid: { mainCols: 4, mainRows: 3, subRadius: 3 },
    controllers: { A: 'human', B: 'human' },
  });
  for (let i = 0; i < 40 && s.phase === 'strategic'; i++) {
    const a = s.armies.find((x) => x.team === 'A' && x.movesLeft > 0);
    if (s.active === 'A' && a) {
      const { world } = worldOf(s);
      const b = s.armies.find((x) => x.team === 'B')!;
      const tgt = world.mainByKey.get(b.at)!;
      const next = mainNeighbors(world, a.at).sort(
        (x, y) =>
          Math.hypot(x.col - tgt.col, x.row - tgt.row) -
          Math.hypot(y.col - tgt.col, y.row - tgt.row),
      )[0]!;
      const r = apply(s, { type: 'moveArmy', armyId: a.id, dest: next.key });
      if (!r.error) {
        s = r.state;
        continue;
      }
    }
    s = apply(s, { type: 'endTurn' }).state;
  }
  s = apply(s, { type: 'startBattle' }).state;
  s = apply(s, { type: 'finishDeploy' }).state;
  return apply(s, { type: 'finishDeploy' }).state;
}

describe('scene building', () => {
  it('strategic scene draws every sub-hex of the configured grid', () => {
    const s = createGame({
      ...defaultSettings(),
      grid: { mainCols: 5, mainRows: 4, subRadius: 3 },
    });
    const spec = buildStrategicScene(s, UI, 'A');
    expect(spec.cells).toHaveLength(5 * 4 * clusterSize(3));
    expect(spec.cells.length).toBe(buildWorld(s.settings.grid).subs.length);
    expect(spec.borders[0]!.segments.length).toBeGreaterThan(0);
  });

  it('tactical scene hides enemies the viewer has not spotted', () => {
    const s = battleState();
    expect(s.battle?.phase).toBe('combat');
    const { spec, ctx, visible } = buildTacticalScene(s, UI, 'A');
    expect(spec.cells).toHaveLength(ctx.cells.size);
    for (const t of spec.tokens.filter((x) => x.team === 'B')) {
      const u = s.battle!.units.find((x) => x.id === t.id)!;
      expect(visible!.has(u.pos!) || u.revealed).toBe(true);
    }
    // Omniscient spectator sees everyone.
    const all = buildTacticalScene(s, UI, null).spec.tokens;
    expect(all).toHaveLength(s.battle!.units.filter((u) => u.hp > 0).length);
  });

  describe('information overlays', () => {
    it('BASIC paints every cell the same neutral tone', () => {
      const s = battleState();
      const { spec } = buildTacticalScene(s, UI, null, 'basic');
      expect(new Set(spec.cells.map((c) => c.fill))).toEqual(new Set([BASIC_FILL]));
    });

    it('HEIGHT colours cells by elevation', () => {
      const s = battleState();
      const { spec } = buildTacticalScene(s, UI, null, 'height');
      for (const c of spec.cells) expect(c.fill).toBe(HEIGHT_FILL[c.h]);
      expect(new Set(spec.cells.map((c) => c.fill)).size).toBeGreaterThan(2);
    });

    it('CONTROL highlights exactly the capture point cells', () => {
      const s = battleState();
      const { spec, ctx } = buildTacticalScene(s, UI, null, 'control');
      const captureCells = new Set(ctx.world.mainByKey.get(s.battle!.contested)!.subKeys);
      const captureFill = spec.cells.find((c) => captureCells.has(c.key))!.fill;
      for (const c of spec.cells) {
        if (captureCells.has(c.key)) expect(c.fill).toBe(captureFill);
        else expect(c.fill).not.toBe(captureFill);
      }
    });

    it('the capture-point outline is drawn in every overlay', () => {
      const s = battleState();
      for (const o of OVERLAYS) {
        const { spec } = buildTacticalScene(s, UI, null, o.id);
        const outline = spec.borders.find((b) => b.color === CAPTURE_COLOR);
        expect(outline?.segments.length).toBeGreaterThan(0);
      }
    });

    it('strategic CONTROL tints territory by owner; BASIC does not', () => {
      const s = createGame({
        ...defaultSettings(),
        grid: { mainCols: 4, mainRows: 3, subRadius: 2 },
      });
      const byOwner = (mode: 'basic' | 'control'): Set<number> =>
        new Set(buildStrategicScene(s, UI, 'A', mode).cells.map((c) => c.fill));
      expect(byOwner('basic').size).toBe(1);
      expect(byOwner('control').size).toBe(3); // Alpha, Bravo, neutral
    });
  });

  describe('main-grid outlines', () => {
    const key = (p: { x: number; y: number; z: number }): string =>
      `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;

    function danglingEnds(segs: Segment3[]): number {
      const degree = new Map<string, number>();
      for (const s of segs)
        for (const p of [s.a, s.b]) degree.set(key(p), (degree.get(key(p)) ?? 0) + 1);
      return [...degree.values()].filter((d) => d < 2).length;
    }

    it('every main hex draws its complete outline (not one side per shared edge)', () => {
      const s = createGame({
        ...defaultSettings(),
        grid: { mainCols: 4, mainRows: 3, subRadius: 3 },
      });
      const { world, terrain } = worldOf(s);
      const hOf = (k: string): number => terrain.heights[world.subByKey.get(k)!.index]!;
      const segs = mainOutline(
        world,
        world.mains.map((m) => m.key),
        hOf,
      );
      const horizontal = segs.filter((x) => Math.abs(x.a.y - x.b.y) < 1e-9);
      const expected = world.mains.reduce((n, m) => n + mainBoundary(world, m.key).length, 0);
      expect(horizontal).toHaveLength(expected);
      for (const m of world.mains) expect(mainBoundary(world, m.key)).toHaveLength(6 * (2 * 3 + 1));
    });

    it('outlines form continuous chains — vertical connectors join every height step', () => {
      const s = battleState();
      const spec = buildTacticalScene(s, UI, null, 'basic').spec;
      for (const layer of spec.borders) {
        expect(layer.segments.some((x) => Math.abs(x.a.y - x.b.y) > 1e-9)).toBe(true);
        expect(danglingEnds(layer.segments)).toBe(0);
      }
    });

    it('battle-map outlines never float above out-of-play terrain', () => {
      const s = battleState();
      const { spec, ctx } = buildTacticalScene(s, UI, null, 'basic');
      const terrain = generateTerrain(ctx.world, s.settings.seed);
      const rendered = [...ctx.cells].map((k) => {
        const sub = ctx.world.subByKey.get(k)!;
        return { ...hexToWorld(sub.hex), top: topY(terrain.heights[sub.index]!) };
      });
      const maxTop = Math.max(...rendered.map((c) => c.top));
      for (const layer of spec.borders) {
        for (const seg of layer.segments) {
          if (Math.abs(seg.a.y - seg.b.y) > 1e-9) continue; // verticals checked via chain test
          const mx = (seg.a.x + seg.b.x) / 2;
          const mz = (seg.a.z + seg.b.z) / 2;
          // The edge must sit on top of a rendered cell it borders (≈0.866 from its centre).
          const owner = rendered.find(
            (c) => Math.hypot(c.x - mx, c.z - mz) < 0.9 && Math.abs(c.top + 0.03 - seg.a.y) < 1e-6,
          );
          expect(owner).toBeDefined();
          expect(seg.a.y).toBeLessThanOrEqual(maxTop + 0.031);
        }
      }
    });
  });

  describe('unit tokens', () => {
    it('show action points next to the name and glow only while AP remain', () => {
      const s = battleState();
      const b = s.battle!;
      const mine = b.units.find((u) => u.team === b.active)!;
      const token = (g: GameState): TokenSpec =>
        buildTacticalScene(g, UI, null).spec.tokens.find((t) => t.id === mine.id)!;
      expect(token(s).label).toMatch(/^[A-Z]+ \(2\/2\)$/);
      expect(token(s).ready).toBe(true);
      expect(token(s).model).toBe(mine.typeId);

      const moved = structuredClone(s);
      Object.assign(
        moved.battle!.units.find((u) => u.id === mine.id)!,
        { moved: true, mp: 1 },
      );
      expect(token(moved).label).toMatch(/\(1\/2\)$/);
      expect(token(moved).ready).toBe(true);

      const acted = structuredClone(s);
      Object.assign(
        acted.battle!.units.find((u) => u.id === mine.id)!,
        { acted: true, mp: 0 },
      );
      expect(token(acted).label).toMatch(/\(0\/2\)$/);
      expect(token(acted).ready).toBe(false);
      expect(token(acted).spent).toBe(true);
    });

    it('the side not on turn shows no AP and no glow', () => {
      const s = battleState();
      const b = s.battle!;
      const theirs = buildTacticalScene(s, UI, null).spec.tokens.filter((t) => t.team !== b.active);
      expect(theirs.length).toBeGreaterThan(0);
      for (const t of theirs) {
        expect(t.label).not.toMatch(/\(/);
        expect(t.ready).toBe(false);
      }
    });
  });
});
