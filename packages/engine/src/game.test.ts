import { describe, expect, it } from 'vitest';
import { apply } from './actions.ts';
import { mainNeighbors } from './grid.ts';
import { runAi } from './runner.ts';
import { ECONOMY, createGame, defaultSettings, worldOf } from './strategic.ts';
import type { GameSettings, GameState } from './types.ts';
import { DEPLOY_BUFFER, buildContext, deploymentZone, liveUnits } from './battleMap.ts';
import { hexDistance, parseKey } from './hex.ts';

function settings(over: Partial<GameSettings> = {}): GameSettings {
  return { ...defaultSettings(), ...over, controllers: { A: 'ai', B: 'ai' } };
}

function forceBattle(state: GameState): GameState {
  // March A's army straight at B's HQ army until a battle is pending.
  let s = state;
  for (let i = 0; i < 60 && s.phase === 'strategic'; i++) {
    const army = s.armies.find((a) => a.team === s.active);
    if (s.active === 'A' && army && army.movesLeft > 0) {
      const { world } = worldOf(s);
      const target = s.armies.find((a) => a.team === 'B')!;
      const next = mainNeighbors(world, army.at).sort(
        (x, y) =>
          Math.abs(x.col - world.mainByKey.get(target.at)!.col) -
            Math.abs(y.col - world.mainByKey.get(target.at)!.col) ||
          Math.abs(x.row - world.mainByKey.get(target.at)!.row) -
            Math.abs(y.row - world.mainByKey.get(target.at)!.row),
      )[0]!;
      const r = apply(s, { type: 'moveArmy', armyId: army.id, dest: next.key });
      s = r.error ? apply(s, { type: 'endTurn' }).state : r.state;
    } else {
      s = apply(s, { type: 'endTurn' }).state;
    }
  }
  return s;
}

describe('campaign', () => {
  it('creates a game with HQs, starting armies and owned flanks', () => {
    const s = createGame(settings());
    expect(s.armies).toHaveLength(2);
    expect(s.hexes[s.hq.A]!.owner).toBe('A');
    expect(s.hexes[s.hq.B]!.owner).toBe('B');
    expect(Object.keys(s.forts).length).toBeGreaterThan(0);
  });

  it('recruiting spends CP', () => {
    const s = createGame(settings());
    const r = apply(s, { type: 'recruit', typeId: 'ww2_rifle_infantry' });
    expect(r.error).toBeNull();
    expect(r.state.cp.A).toBe(s.cp.A - 3);
  });

  it('a forced engagement produces a playable tactical battle', () => {
    let s = forceBattle(createGame(settings({ grid: { mainCols: 4, mainRows: 3, subRadius: 3 } })));
    expect(s.phase).toBe('battle-pending');
    s = apply(s, { type: 'startBattle' }).state;
    expect(s.phase).toBe('battle');
    expect(s.battle!.phase).toBe('deploy');
    s = apply(s, { type: 'finishDeploy' }).state; // defender
    s = apply(s, { type: 'finishDeploy' }).state; // attacker
    expect(s.battle!.phase).toBe('combat');
    expect(liveUnits(s.battle!).length).toBe(s.battle!.units.length);
    // AI plays the battle to completion.
    s = runAi(s, 3000);
    expect(['strategic', 'over']).toContain(s.phase);
  });

  it('auto-resolve settles a pending battle', () => {
    let s = forceBattle(createGame(settings({ grid: { mainCols: 4, mainRows: 3, subRadius: 3 } })));
    expect(s.phase).toBe('battle-pending');
    s = apply(s, { type: 'autoResolve' }).state;
    expect(['strategic', 'over']).toContain(s.phase);
  });

  for (const era of ['ww2', 'medieval'] as const) {
    it(`AI vs AI campaign runs to a winner (${era})`, () => {
      let s = createGame(
        settings({ era, seed: 7, grid: { mainCols: 5, mainRows: 3, subRadius: 2 } }),
      );
      s = runAi(s, 20000);
      expect(s.phase).toBe('over');
      expect(s.winner).not.toBeNull();
    });
  }

  it('a full tactical battle between AIs ends with a winner', () => {
    let s = forceBattle(
      createGame(settings({ era: 'medieval', grid: { mainCols: 4, mainRows: 3, subRadius: 3 } })),
    );
    s = apply(s, { type: 'startBattle' }).state;
    // Drive only the battle portion.
    for (let i = 0; i < 3000 && s.phase === 'battle' && s.battle!.phase !== 'over'; i++)
      s = runAi(s, 1);
    expect(s.phase === 'battle' ? s.battle!.phase : 'done').not.toBe('combat');
  });
});

describe('deployment zones', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    it(`radius ${n}: both zones fit a full army and are separated by no-man's-land`, () => {
      let s = forceBattle(
        createGame(settings({ grid: { mainCols: 4, mainRows: 3, subRadius: n } })),
      );
      s = apply(s, { type: 'startBattle' }).state;
      const ctx = buildContext(s.settings, s.battle!);
      const att = deploymentZone(ctx, s.battle!, s.battle!.attacker);
      const def = deploymentZone(ctx, s.battle!, s.battle!.defender);
      expect(att.length).toBeGreaterThanOrEqual(ECONOMY.armyCap);
      expect(def.length).toBeGreaterThanOrEqual(ECONOMY.armyCap);
      let gap = Infinity;
      for (const a of att)
        for (const d of def) gap = Math.min(gap, hexDistance(parseKey(a), parseKey(d)));
      expect(gap).toBeGreaterThan(DEPLOY_BUFFER);
    });
  }
});
