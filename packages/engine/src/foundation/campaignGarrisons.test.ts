import { describe, expect, it } from 'vitest';
import { createGame, defaultSettings, worldOf } from '../strategic.ts';
import {
  createBattle,
  actionPoints,
  autoDeploy,
  deployUnit,
  digIn,
  moveUnit,
  packUp,
  placeWarnedFort,
  rotateUnit,
  retreat,
  setUp,
  startTurn,
  warnedRangeCells,
} from '../tactical.ts';
import { buildContext, withTerrainOverride } from '../battleMap.ts';
import { hexDistance, parseKey } from '../hex.ts';
import { createRng } from '../rng.ts';
import { generateTerrain } from '../terrain.ts';
import { resolveAttack } from '../combat.ts';
import { withRules } from '../rules.ts';
import { unitType } from '../units.ts';
import type { Army, ArmyUnit, GameState } from '../types.ts';
import { flatBattle, mkUnit, scriptedRng } from '../testBattle.ts';
import { initializeCampaignFoundation } from './campaign.ts';
import { createFoundationPlaytestConfiguration } from './playtestProfile.ts';
import {
  beginCampaignFreeShots,
  campaignFreeShotPrompt,
  campaignGarrisonTargetOptions,
  commitCampaignStationing,
  openCampaignGarrisonCycle,
  prepareCampaignStationing,
  resolveCampaignFreeShot,
  selectCampaignFreeShotTarget,
  toggleCampaignStationing,
  validateCampaignGarrisonState,
} from './campaignGarrisons.ts';

function flat<T>(run: () => T): T {
  return withTerrainOverride((world, seed) => {
    const terrain = generateTerrain(world, seed);
    terrain.heights.fill(2);
    return terrain;
  }, run);
}
function game(): GameState {
  const state = createGame({
    ...defaultSettings(),
    grid: { mainCols: 4, mainRows: 3, subRadius: 3 },
    fog: false,
    controllers: { A: 'human', B: 'human' },
  });
  // Isolate real-state adapters from the separately tested turn-start orchestrator.
  state.settings.infrastructure = createFoundationPlaytestConfiguration(25, 10);
  initializeCampaignFoundation(state);
  return state;
}
function unit(id: string, typeId = 'ww2_rifle_infantry'): ArmyUnit {
  return { id, typeId, label: id, hp: unitType(typeId).hp };
}
function holder(
  state: GameState,
  id: string,
  team: 'A' | 'B',
  pos: string,
  units: ArmyUnit[],
  temporary = false,
): Army {
  const { world } = worldOf(state);
  return {
    id,
    team,
    pos,
    at: world.subByKey.get(pos)!.main,
    units,
    kind: temporary ? 'garrison' : 'commander',
    ...(temporary ? { building: 'temporary' as const } : {}),
    movesLeft: temporary ? 0 : 7,
  };
}
function seedForHit(): number {
  for (let seed = 1; seed < 100; seed++) {
    const random = createRng(seed);
    random.next();
    if (random.die(20) >= 15) return seed;
  }
  throw new Error('No deterministic hit fixture');
}
function strategicFixture(shooterType = 'ww2_mortar'): GameState {
  const state = game();
  state.armies = [
    holder(state, 'guard-holder', 'A', '0,0', [unit('guard', shooterType)], true),
    holder(state, 'enemy-commander', 'B', '5,0', [
      unit('enemy-1'),
      unit('enemy-2'),
      unit('enemy-3'),
    ]),
  ];
  state.rng = seedForHit();
  return state;
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: actual campaign garrisons and free shots', () => {
  it('saves deliberate fort/road stationing choices and commits only the selected survivor', () => {
    const state = game();
    const { world } = worldOf(state);
    const commander = holder(state, 'winner', 'A', '0,1', [unit('stay'), unit('return')]);
    const enemy = holder(state, 'loser', 'B', '5,0', [unit('enemy')]);
    state.armies = [commander, enemy];
    const battle = createBattle(state, commander, enemy, commander.at, enemy.at, world);
    battle.phase = 'over';
    battle.winner = 'A';
    battle.units.find((u) => u.id === 'stay')!.pos = '1,0';
    battle.units.find((u) => u.id === 'stay')!.facing = 5;
    battle.units.find((u) => u.id === 'return')!.pos = '2,0';
    battle.forts['1,0'] = 1;
    state.battle = battle;
    state.phase = 'battle';
    expect(prepareCampaignStationing(state, battle, [{ subHex: '2,0', kind: 'road' }]).ok).toBe(
      true,
    );
    expect(state.infrastructure!.garrisons!.pendingStationing!.candidates).toHaveLength(2);
    expect(toggleCampaignStationing(state, 'stay', 0).ok).toBe(true);
    const restored: GameState = JSON.parse(JSON.stringify(state));
    expect(restored.infrastructure!.garrisons!.pendingStationing!.selectedUnitIds).toEqual([
      'stay',
    ]);
    expect(validateCampaignGarrisonState(restored)).toBeNull();
    expect(commitCampaignStationing(restored, 1).ok).toBe(true);
    const guard = restored.armies.find((a) => a.building === 'temporary')!;
    expect(guard).toMatchObject({
      kind: 'garrison',
      pos: '1,0',
      movesLeft: 0,
      stationedFacing: 5,
      units: [{ id: 'stay' }],
    });
    expect(restored.armies.find((a) => a.id === 'winner')!.units.map((u) => u.id)).toEqual([
      'return',
    ]);
    expect(restored.infrastructure!.garrisons!.pendingStationing).toBeNull();
    expect(restored.infrastructure!.garrisons!.completedStationingBattleIds).toContain(battle.id);
    expect(validateCampaignGarrisonState(restored)).toBeNull();
    const next = createBattle(
      restored,
      restored.armies.find((army) => army.id === 'winner')!,
      restored.armies.find((army) => army.id === 'loser')!,
      '0,0',
      '1,0',
      world,
    );
    expect(next.units.find((unit) => unit.id === 'stay')).toMatchObject({
      stationed: true,
      pos: '1,0',
      facing: 5,
    });
    expect(restored.battle!.units.find((unit) => unit.id === 'stay')!.facing).toBe(5);
  });

  it('reuses an existing saved fort without requiring engineer provenance or requalification', () => {
    const state = game();
    const { world } = worldOf(state);
    const commander = holder(state, 'winner', 'A', '0,1', [unit('rifle')]);
    const enemy = holder(state, 'loser', 'B', '5,0', [unit('enemy')]);
    state.armies = [commander, enemy];
    const battle = createBattle(state, commander, enemy, commander.at, enemy.at, world);
    battle.phase = 'over';
    battle.winner = 'A';
    battle.units.find((u) => u.id === 'rifle')!.pos = '1,0';
    battle.forts['1,0'] = 2;
    state.battle = battle;
    state.phase = 'battle';
    const restored: GameState = JSON.parse(JSON.stringify(state));
    expect(prepareCampaignStationing(restored, restored.battle!, []).ok).toBe(true);
    expect(restored.infrastructure!.garrisons!.pendingStationing!.candidates[0].tileKind).toBe(
      'fort',
    );
    expect(toggleCampaignStationing(restored, 'rifle', 0).ok).toBe(true);
    expect(commitCampaignStationing(restored, 1).ok).toBe(true);
    expect(validateCampaignGarrisonState(restored)).toBeNull();
  });

  it('rejects stale stationing without splitting units or consuming another ID', () => {
    const state = game();
    const { world } = worldOf(state);
    const commander = holder(state, 'winner', 'A', '0,1', [unit('rifle')]);
    const enemy = holder(state, 'loser', 'B', '5,0', [unit('enemy')]);
    state.armies = [commander, enemy];
    state.battle = createBattle(state, commander, enemy, commander.at, enemy.at, world);
    state.battle.phase = 'over';
    state.battle.winner = 'A';
    state.battle.units[0].pos = '1,0';
    state.battle.forts['1,0'] = 1;
    prepareCampaignStationing(state, state.battle, []);
    toggleCampaignStationing(state, 'rifle', 0);
    const snapshot = JSON.stringify(state);
    expect(commitCampaignStationing(state, 0).ok).toBe(false);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('uses the chosen commander, damages all packed troops with splash and persists one shot', () =>
    flat(() => {
      withRules(
        {
          units: {
            ww2_mortar: {
              direct: { count: 1, sides: 6, bonus: 20 },
              splash: { count: 1, sides: 6, bonus: 20 },
            },
          },
        },
        () => {
          const state = strategicFixture();
          // Already-wounded survivors make this fixture exercise dead-holder cleanup
          // without changing the combat engine's siege variance or armor formulas.
          state.armies
            .find((a) => a.id === 'enemy-commander')!
            .units.forEach((u) => {
              u.hp = 1;
            });
          const cp = { ...state.cp };
          expect(
            campaignGarrisonTargetOptions(state, 'guard', 'strategic-after-income').map(
              (o) => o.targetId,
            ),
          ).toEqual(['enemy-commander']);
          expect(beginCampaignFreeShots(state, 'strategic-after-income', 'A').ok).toBe(true);
          expect(selectCampaignFreeShotTarget(state, 'enemy-commander').ok).toBe(true);
          const saved: GameState = JSON.parse(JSON.stringify(state));
          expect(validateCampaignGarrisonState(saved)).toBeNull();
          const result = resolveCampaignFreeShot(saved);
          expect(result.ok).toBe(true);
          expect(result.ok && result.outcome!.hits.map((h) => h.unitId).sort()).toEqual([
            'enemy-1',
            'enemy-2',
            'enemy-3',
          ]);
          expect(saved.armies.find((a) => a.id === 'enemy-commander')).toBeUndefined();
          expect(saved.infrastructure!.garrisons!.freeShots.receipts).toHaveLength(1);
          expect(saved.cp).toEqual(cp);
          expect(validateCampaignGarrisonState(saved)).toBeNull();
          const after = JSON.stringify(saved);
          expect(resolveCampaignFreeShot(saved).ok).toBe(false);
          expect(JSON.stringify(saved)).toBe(after);
        },
      );
    }));

  it('uses seeded single-target fallback within the explicitly selected commander only', () =>
    flat(() => {
      withRules(
        { units: { ww2_rifle_infantry: { direct: { count: 1, sides: 6, bonus: 20 } } } },
        () => {
          const state = strategicFixture('ww2_rifle_infantry');
          beginCampaignFreeShots(state, 'strategic-after-income', 'A');
          expect(selectCampaignFreeShotTarget(state, 'enemy-commander').ok).toBe(true);
          const restored: GameState = JSON.parse(JSON.stringify(state));
          expect(resolveCampaignFreeShot(state).ok).toBe(true);
          expect(resolveCampaignFreeShot(restored).ok).toBe(true);
          expect(state.armies.find((a) => a.id === 'enemy-commander')!.units).toHaveLength(2);
          expect(restored.armies).toEqual(state.armies);
          expect(restored.rng).toBe(state.rng);
        },
      );
    }));

  it('does not spend or select automatically when no commander is in legal range', () =>
    flat(() => {
      const state = strategicFixture();
      const { world } = worldOf(state);
      const enemy = state.armies.find((a) => a.id === 'enemy-commander')!;
      const far = [...world.subs].sort(
        (a, b) => hexDistance(b.hex, parseKey('0,0')) - hexDistance(a.hex, parseKey('0,0')),
      )[0];
      enemy.pos = far.key;
      enemy.at = far.main;
      expect(beginCampaignFreeShots(state, 'strategic-after-income', 'A').ok).toBe(true);
      expect(campaignFreeShotPrompt(state)).toEqual({ ok: true, status: 'complete' });
      expect(state.infrastructure!.garrisons!.freeShots.receipts).toHaveLength(0);
    }));

  it('shares actual campaign allowance across boundaries without replaying money', () =>
    flat(() => {
      const state = strategicFixture('ww2_rifle_infantry');
      const cp = { ...state.cp };
      beginCampaignFreeShots(state, 'strategic-after-income', 'A');
      selectCampaignFreeShotTarget(state, 'enemy-commander');
      expect(resolveCampaignFreeShot(state).ok).toBe(true);
      const before = state.infrastructure!.garrisons!.freeShots.receipts.length;
      const restored: GameState = JSON.parse(JSON.stringify(state));
      expect(beginCampaignFreeShots(restored, 'strategic-after-income', 'A').ok).toBe(true);
      expect(restored.infrastructure!.garrisons!.freeShots.receipts).toHaveLength(before);
      expect(restored.cp).toEqual(cp);
      expect(openCampaignGarrisonCycle(restored, 'A', 'A:next').ok).toBe(true);
      expect(beginCampaignFreeShots(restored, 'strategic-after-income', 'A').ok).toBe(true);
      expect(campaignFreeShotPrompt(restored)).toMatchObject({ status: 'choose-target' });
    }));

  it('resolves a real tactical deployment shot without spending normal firing or movement actions', () =>
    flat(() => {
      const state = game();
      const { world } = worldOf(state);
      const attacker = holder(state, 'attacker', 'A', '0,1', [unit('a')]);
      const defender = holder(state, 'defender', 'B', '5,0', [unit('b')]);
      const guard = holder(state, 'tile', 'A', '0,0', [unit('g', 'ww2_mortar')], true);
      state.armies = [attacker, defender, guard];
      const battle = createBattle(state, attacker, defender, attacker.at, defender.at, world);
      for (const u of battle.units) {
        if (!u.pos) u.pos = state.armies.find((a) => a.id === u.holderId)!.pos;
      }
      battle.phase = 'combat';
      battle.round = 1;
      state.battle = battle;
      state.phase = 'battle';
      const before = battle.units.map((u) => ({
        id: u.id,
        mp: u.mp,
        acted: u.acted,
        moved: u.moved,
      }));
      expect(beginCampaignFreeShots(state, 'tactical-after-deployment').ok).toBe(true);
      expect(campaignFreeShotPrompt(state)).toMatchObject({
        status: 'choose-target',
        shooterId: 'g',
        targetIds: ['b'],
      });
      expect(selectCampaignFreeShotTarget(state, 'b').ok).toBe(true);
      const restored: GameState = JSON.parse(JSON.stringify(state));
      expect(validateCampaignGarrisonState(restored)).toBeNull();
      expect(resolveCampaignFreeShot(restored).ok).toBe(true);
      expect(
        restored.battle!.units.map((u) => ({ id: u.id, mp: u.mp, acted: u.acted, moved: u.moved })),
      ).toEqual(before);
      expect(actionPoints(restored.battle!.units.find((u) => u.id === 'g')!)).toEqual({
        left: 1,
        max: 1,
      });
      expect(restored.infrastructure!.garrisons!.freeShots.receipts).toHaveLength(1);
      expect(beginCampaignFreeShots(restored, 'tactical-after-deployment').ok).toBe(true);
      expect(restored.infrastructure!.garrisons!.freeShots.receipts).toHaveLength(1);
      expect(validateCampaignGarrisonState(restored)).toBeNull();
    }));
});

describe('GAMES-ELEVATE-TACTICAL-UC-001: fixed stationed deployment and firing-only orders', () => {
  it('records the withdrawing side explicitly without altering tactical HP or positions', () => {
    const { battle } = flatBattle([
      mkUnit('attacker', 'ww2_rifle_infantry', 'A', '0,0'),
      mkUnit('defender', 'ww2_rifle_infantry', 'B', '1,0'),
    ]);
    const before = structuredClone(battle.units);
    expect(retreat(battle, 'A')).toEqual({ ok: true });
    expect(battle).toMatchObject({ phase: 'over', winner: 'B', withdrawnTeam: 'A' });
    expect(battle.units).toEqual(before);
    expect(retreat(battle, 'B').ok).toBe(false);
    expect(battle.withdrawnTeam).toBe('A');
  });

  it('deploys footprint garrisons at saved positions and rejects every movement/non-firing order', () => {
    const state = game();
    const { world } = worldOf(state);
    const attacker = holder(state, 'attacker', 'A', '0,1', [unit('a')]);
    const defender = holder(state, 'defender', 'B', '5,0', [unit('b')]);
    const guard = holder(state, 'tile', 'A', '0,0', [unit('g', 'ww2_engineer')], true);
    guard.stationedFacing = 4;
    state.armies = [attacker, defender, guard];
    const battle = createBattle(state, attacker, defender, attacker.at, defender.at, world);
    const g = battle.units.find((u) => u.id === 'g')!;
    expect(g).toMatchObject({ pos: '0,0', stationed: true, holderId: 'tile', mp: 0, facing: 4 });
    const ctx = buildContext(state.settings, battle);
    battle.deployTeam = 'A';
    expect(deployUnit(ctx, battle, 'g', null).ok).toBe(false);
    autoDeploy(ctx, battle, 'A', createRng(1));
    expect(g.pos).toBe('0,0');
    battle.phase = 'combat';
    battle.active = 'A';
    startTurn(battle, 'A');
    for (const result of [
      moveUnit(ctx, battle, 'g', '1,0'),
      setUp(battle, 'g'),
      packUp(battle, 'g'),
      digIn(battle, 'g'),
      rotateUnit(battle, 'g', 1),
    ])
      expect(result.ok).toBe(false);
    expect(actionPoints(g)).toEqual({ left: 1, max: 1 });
    expect(g.pos).toBe('0,0');
  });

  it('requires a living friendly MainHex engineer for new warned forts while retaining existing deployment budget', () => {
    const fixture = flatBattle([mkUnit('rifle', 'ww2_rifle_infantry', 'B', '0,0')], {
      phase: 'deploy',
      deployTeam: 'B',
      defender: 'B',
      warnedPlacements: 2,
      warnedRange: 6,
    });
    const cell = [...warnedRangeCells(fixture.ctx, fixture.battle)][0]!;
    expect(cell).toBeTruthy();
    const before = fixture.battle.warnedPlacements;
    expect(placeWarnedFort(fixture.ctx, fixture.battle, cell).ok).toBe(false);
    const engineer = mkUnit('engineer', 'ww2_engineer', 'B', cell);
    fixture.battle.units.push(engineer);
    expect(placeWarnedFort(fixture.ctx, fixture.battle, cell).ok).toBe(true);
    expect(fixture.battle.warnedPlacements).toBe(before - 1);
    expect(engineer.acted).toBe(false);
  });
});

describe('GAMES-ELEVATE-TACTICAL-UC-002: packed splash reuses ordinary combat resolution', () => {
  it('hits other packed units at impact using the existing splash pool and one attack roll', () => {
    const shooter = mkUnit('mortar', 'ww2_mortar', 'A', '0,0');
    shooter.deployed = true;
    const one = mkUnit('one', 'ww2_rifle_infantry', 'B', '5,0');
    const two = mkUnit('two', 'ww2_rifle_infantry', 'B', '5,0');
    const fixture = flatBattle([shooter, one, two]);
    fixture.ctx.unitAt.set('5,0', one);
    const result = resolveAttack(
      fixture.ctx,
      scriptedRng([20, 6, 6, 6, 6]),
      fixture.battle,
      shooter,
      '5,0',
      { packedUnitIds: ['one', 'two'] },
    );
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.roll).toBe(20);
    expect(result.hits.map((h) => h.unitId).sort()).toEqual(['one', 'two']);
    expect(result.log.some((entry) => entry.text.includes('Packed splash'))).toBe(true);
  });

  it('leaves ordinary attack behavior unchanged and rejects invalid packed lists before RNG/spend', () => {
    const fixture = flatBattle([
      mkUnit('mortar', 'ww2_mortar', 'A', '0,0'),
      mkUnit('one', 'ww2_rifle_infantry', 'B', '5,0'),
    ]);
    fixture.battle.units[0].deployed = true;
    const deployed = JSON.stringify(fixture.battle);
    const rng = scriptedRng([20, 6]);
    expect(
      resolveAttack(fixture.ctx, rng, fixture.battle, fixture.battle.units[0], '5,0', {
        packedUnitIds: ['missing'],
      }),
    ).toHaveProperty('error');
    expect(JSON.stringify(fixture.battle)).toBe(deployed);
    expect(rng.state()).toBe(0);
    const result = resolveAttack(fixture.ctx, rng, fixture.battle, fixture.battle.units[0], '5,0');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.hits.map((h) => h.unitId)).toEqual(['one']);
  });
});
