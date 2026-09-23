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
});
