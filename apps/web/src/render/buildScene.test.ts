import { describe, expect, it } from 'vitest';
import type { GameState } from '@iron-ridge/engine';
import {
  apply,
  buildWorld,
  clusterSize,
  createGame,
  defaultSettings,
  mainNeighbors,
  worldOf,
} from '@iron-ridge/engine';
import { buildStrategicScene, buildTacticalScene } from './buildScene.ts';
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
});
