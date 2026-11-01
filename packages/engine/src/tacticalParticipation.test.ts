import { describe, expect, it } from 'vitest';
import { apply } from './actions.ts';
import type { GameAction } from './actions.ts';
import { buildContext, deploymentZone, refreshOccupancy } from './battleMap.ts';
import { EXPERIMENTAL_ENGAGEMENT_PROFILE } from './engagement.ts';
import { mainNeighbors } from './grid.ts';
import { hexDistance, hexKey, neighbors, parseKey } from './hex.ts';
import { createRng } from './rng.ts';
import { createGame, defaultSettings, makeUnit, setHolderPos, worldOf } from './strategic.ts';
import { createBattle, deployUnit, finishDeployment, hasDeploymentCapacity } from './tactical.ts';
import type { Army, GameState, Team } from './types.ts';
import { createFoundationPlaytestConfiguration } from './foundation/playtestProfile.ts';

function add(state: GameState, team: Team, pos: string, id: string, movesLeft = 20): Army {
  const army: Army = {
    id,
    team,
    kind: 'commander',
    pos,
    at: '',
    movesLeft,
    units: [{ ...makeUnit(state, team, 'ww2_rifle_infantry'), facing: team === 'A' ? 4 : 1 }],
  };
  setHolderPos(worldOf(state).world, army, pos);
  state.armies.push(army);
  return army;
}
function fixture(foundation = false): GameState {
  const state = createGame({
    ...defaultSettings(),
    grid: { mainCols: 5, mainRows: 3, subRadius: 2 },
    fog: false,
    controllers: { A: 'human', B: 'human' },
    commanderTrainingCp: 11,
    engagement: { ...EXPERIMENTAL_ENGAGEMENT_PROFILE },
    ...(foundation ? { infrastructure: createFoundationPlaytestConfiguration(7, 3) } : {}),
  });
  state.armies = [];
  state.cp = { A: 100, B: 100 };
  const world = worldOf(state).world;
  const target = world.mains.find((main) => main.col === 2 && main.row === 1)!;
  const defender = target.subKeys.find((key) =>
    neighbors(parseKey(key)).some((h) => {
      const sub = world.subByKey.get(hexKey(h));
      return sub && sub.main !== target.key;
    }),
  )!;
  const attacker = neighbors(parseKey(defender))
    .map(hexKey)
    .find((key) => {
      const sub = world.subByKey.get(key);
      return sub && sub.main !== target.key;
    })!;
  add(state, 'A', attacker, 'primary-A');
  add(state, 'B', defender, 'primary-B');
  const initialFootprint = new Set([
    target.key,
    ...mainNeighbors(world, target.key).map((m) => m.key),
  ]);
  const far = world.subs.find((sub) => !initialFootprint.has(sub.main))!;
  add(state, 'A', far.key, 'extra-A');
  const freeLocal = (main: string): string =>
    world.mainByKey
      .get(main)!
      .subKeys.find((key) => !state.armies.some((army) => army.pos === key))!;
  add(state, 'A', freeLocal(state.armies[0]!.at), 'local-A', 0);
  add(state, 'B', freeLocal(target.key), 'extra-B', 0);
  add(state, 'B', freeLocal(target.key), 'declined-B', 3);
  return state;
}
function step(state: GameState, action: GameAction): GameState {
  const result = apply(state, action);
  expect(result.error, `${action.type}: ${result.error}`).toBeNull();
  return result.state;
}
function selected(state: GameState): GameState {
  let s = step(state, { type: 'engage', armyId: 'primary-A', targetId: 'primary-B' });
  s = step(s, {
    type: 'engagementSelect',
    team: 'A',
    armyIds: ['primary-A', 'extra-A', 'local-A'],
  });
  s = step(s, { type: 'engagementLock', team: 'A' });
  s = step(s, { type: 'engagementSelect', team: 'B', armyIds: ['primary-B', 'extra-B'] });
  return step(s, { type: 'engagementLock', team: 'B' });
}
function opened(state: GameState): GameState {
  return step(selected(state), { type: 'startBattle' });
}

describe('GAMES-ELEVATE-TACTICAL-UC-001: commander anchored deployment and provenance', () => {
  it('commits five commanders with distinct lineage, no extra travel/movement spend and both CP totals', () => {
    const initial = fixture();
    const before = structuredClone(initial);
    const game = opened(initial);
    const battle = game.battle!;
    expect(game.cp).toEqual({ A: 91, B: 98 });
    expect(battle.participationCosts).toEqual({ A: 9, B: 2 });
    expect(battle.participants).toHaveLength(5);
    expect(new Set(battle.units.map((unit) => unit.holderId)).size).toBe(5);
    for (const id of ['extra-A', 'local-A', 'extra-B', 'declined-B'])
      expect(game.armies.find((army) => army.id === id)).toEqual(
        before.armies.find((army) => army.id === id),
      );
    expect(game.nextId).toBe(initial.nextId + 1);
    expect(battle.units.some((unit) => unit.holderId === 'declined-B')).toBe(false);
    const ctx = buildContext(game.settings, battle);
    const extras = battle.participants!.filter((participant) => !participant.primary);
    for (const extra of extras) {
      const zone = deploymentZone(ctx, battle, extra.team, extra.armyId);
      expect(zone.length).toBeGreaterThan(0);
      expect(
        zone.every(
          (key) => ctx.cells.has(key) && hexDistance(parseKey(key), parseKey(extra.pos)) <= 2,
        ),
      ).toBe(true);
    }
    expect(battle.mains).toContain(extras.find((extra) => extra.armyId === 'extra-A')!.at);
    const alpha = new Set(deploymentZone(ctx, battle, 'A'));
    expect(deploymentZone(ctx, battle, 'B').some((key) => alpha.has(key))).toBe(false);
    expect(hasDeploymentCapacity(ctx, battle)).toBe(true);
  });

  it('only deploys a constituent in its own zone and retains explicit facing through auto placement', () => {
    const game = opened(fixture());
    const b = game.battle!;
    const ctx = buildContext(game.settings, b);
    b.deployTeam = 'A';
    const unit = b.units.find((u) => u.holderId === 'extra-A')!;
    const own = new Set(deploymentZone(ctx, b, 'A', unit.holderId));
    const other = deploymentZone(ctx, b, 'A', 'primary-A').find((key) => !own.has(key))!;
    expect(other).toBeTruthy();
    expect(deployUnit(ctx, b, unit.id, other)).toMatchObject({
      ok: false,
      error: 'Outside deployment zone',
    });
    expect(deployUnit(ctx, b, unit.id, [...own][0]!)).toEqual({ ok: true });
    expect(unit.facing).toBe(4);
    b.deployTeam = 'B';
    expect(finishDeployment(ctx, b, createRng(1))).toEqual({ ok: true });
    expect(finishDeployment(ctx, b, createRng(2))).toEqual({ ok: true });
    expect(b.units.every((u) => u.pos !== null)).toBe(true);
    expect(new Set(b.units.map((u) => u.pos)).size).toBe(b.units.length);
    expect(b.units.find((u) => u.holderId === 'extra-A')!.facing).toBe(4);
  });

  it('rejects infeasible forces atomically before charging or allocating a battle ID', () => {
    const state = fixture();
    const extra = state.armies.find((army) => army.id === 'local-A')!;
    for (let i = 0; i < 60; i++) extra.units.push(makeUnit(state, 'A', 'ww2_rifle_infantry'));
    const pending = selected(state);
    const before = structuredClone(pending);
    const result = apply(pending, { type: 'startBattle' });
    expect(result.error).toMatch(/do not fit/);
    expect(result.state).toEqual(before);
    const auto = apply(pending, { type: 'autoResolve' });
    expect(auto.error).toMatch(/do not fit/);
    expect(auto.state).toEqual(before);
  });

  it.each([false, true])(
    'preserves extra holder posture and unit identity on successful extraction (foundation=%s)',
    (foundation) => {
      let game = opened(fixture(foundation));
      const originals = structuredClone(
        game.armies.filter((army) => !army.id.startsWith('primary')),
      );
      game = step(game, { type: 'finishDeploy' });
      game = step(game, { type: 'finishDeploy' });
      const battle = game.battle!;
      const extraUnit = battle.units.find((unit) => unit.holderId === 'extra-A')!;
      extraUnit.facing = 2;
      extraUnit.hp -= 1;
      battle.phase = 'over';
      battle.winner = 'A';
      battle.endReason = 'Captured and extracted';
      battle.extracted = true;
      game = step(game, { type: 'concludeBattle' });
      for (const original of originals) {
        const current = game.armies.find((army) => army.id === original.id)!;
        expect(current.pos).toBe(original.pos);
        expect(current.movesLeft).toBe(original.movesLeft);
        expect(current.units.map((u) => u.id)).toEqual(original.units.map((u) => u.id));
      }
      const survivor = game.armies.find((army) => army.id === 'extra-A')!.units[0]!;
      expect(survivor.hp).toBe(extraUnit.hp);
      expect(survivor.facing).toBe(2);
    },
  );

  it('includes every selected army in auto-resolve casualties while declined force remains exact', () => {
    const state = fixture();
    const declined = structuredClone(state.armies.find((army) => army.id === 'declined-B'));
    const extra = structuredClone(state.armies.find((army) => army.id === 'extra-A'))!;
    const game = step(selected(state), { type: 'autoResolve' });
    expect(game.cp).toEqual({ A: 91, B: 98 });
    const current = game.armies.find((army) => army.id === extra.id)!;
    expect(current.pos).toBe(extra.pos);
    expect(current.movesLeft).toBe(extra.movesLeft);
    expect(current.units[0]!.hp).toBeLessThan(extra.units[0]!.hp);
    expect(game.armies.find((army) => army.id === 'declined-B')).toEqual(declined);
  });

  it('retains the exact legacy primary deployment rule when participants are absent', () => {
    const state = fixture();
    delete state.settings.engagement;
    const world = worldOf(state).world;
    const a = state.armies[0]!,
      d = state.armies[1]!;
    const origin = mainNeighbors(world, d.at).find((main) => main.key !== d.at)!.key;
    const battle = createBattle(state, a, d, origin, d.at, world);
    expect(battle.participants).toBeUndefined();
    const ctx = buildContext(state.settings, battle);
    const n = world.config.subRadius,
      enemy = world.mainByKey.get(battle.contested)!.center;
    expect(deploymentZone(ctx, battle, 'A')).toEqual(
      world.mainByKey
        .get(origin)!
        .subKeys.filter((key) => hexDistance(parseKey(key), enemy) > n + 2),
    );
    refreshOccupancy(ctx, battle);
  });
});
