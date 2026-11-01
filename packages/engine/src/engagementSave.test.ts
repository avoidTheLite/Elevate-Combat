/* eslint-disable @typescript-eslint/no-explicit-any -- corruption cases intentionally edit raw save data */
import { describe, expect, it } from 'vitest';
import type { GameAction } from './actions.ts';
import { apply } from './actions.ts';
import { buildContext, deploymentZone } from './battleMap.ts';
import { EXPERIMENTAL_ENGAGEMENT_PROFILE } from './engagement.ts';
import { DIRECTIONS, hexAdd, hexKey, hexScale } from './hex.ts';
import {
  SAVE_SCHEMA,
  deserializeSave,
  migrateSave,
  serializeSave,
  validateGameState,
} from './save.ts';
import {
  centerKey,
  createGame,
  defaultSettings,
  makeUnit,
  setHolderPos,
  worldOf,
} from './strategic.ts';
import type { Army, GameState, Team } from './types.ts';
import { createFoundationPlaytestConfiguration } from './foundation/playtestProfile.ts';
import { checkVictory } from './tactical.ts';

function step(state: GameState, action: GameAction): GameState {
  const result = apply(state, action);
  expect(result.error, `${action.type}: ${result.error}`).toBeNull();
  return result.state;
}

function battleFixture(foundation = false): {
  state: GameState;
  attacker: string;
  defender: string;
  extraAttacker: string;
  extraDefender: string;
} {
  const state = createGame({
    ...defaultSettings(),
    seed: 42,
    grid: { mainCols: 5, mainRows: 3, subRadius: 3 },
    fog: false,
    commanderTrainingCp: 11,
    controllers: { A: 'human', B: 'human' },
    engagement: { ...EXPERIMENTAL_ENGAGEMENT_PROFILE },
    ...(foundation ? { infrastructure: createFoundationPlaytestConfiguration(7, 3) } : {}),
  });
  const { world } = worldOf(state);
  const middle = foundation
    ? world.mainByKey.get(state.hq.B)!
    : world.mains.find((main) => main.col === 2 && main.row === 1)!;
  const offset = (direction: number, distance: number): string =>
    hexKey(hexAdd(middle.center, hexScale(DIRECTIONS[direction]!, distance)));
  const attacker = state.armies.find((army) => army.team === 'A' && army.kind === 'commander')!;
  const defender = state.armies.find((army) => army.team === 'B' && army.kind === 'commander')!;
  setHolderPos(world, attacker, centerKey(world, middle.key));
  setHolderPos(world, defender, offset(0, 1));
  const extra = (team: Team, pos: string): Army => {
    const holder: Army = {
      id: `${team}-save-extra`,
      team,
      kind: 'commander',
      pos,
      at: world.subByKey.get(pos)!.main,
      movesLeft: 0,
      units: [{ ...makeUnit(state, team, 'ww2_rifle_infantry'), facing: team === 'A' ? 2 : 5 }],
    };
    state.armies.push(holder);
    return holder;
  };
  const extraAttacker = extra('A', offset(2, 2));
  const extraDefender = extra('B', offset(4, 2));
  return {
    state: step(state, { type: 'engage', armyId: attacker.id, targetId: defender.id }),
    attacker: attacker.id,
    defender: defender.id,
    extraAttacker: extraAttacker.id,
    extraDefender: extraDefender.id,
  };
}

function ready(fixture: ReturnType<typeof battleFixture>): GameState {
  let state = step(fixture.state, {
    type: 'engagementSelect',
    team: 'A',
    armyIds: [fixture.attacker, fixture.extraAttacker],
  });
  state = step(state, { type: 'engagementLock', team: 'A' });
  state = step(state, {
    type: 'engagementSelect',
    team: 'B',
    armyIds: [fixture.defender, fixture.extraDefender],
  });
  return step(state, { type: 'engagementLock', team: 'B' });
}

function roundTrip(state: GameState): GameState {
  expect(validateGameState(state)).toEqual([]);
  const loaded = deserializeSave(serializeSave(state, 'engagement', '2026-11-01T00:00:00Z'));
  expect(loaded.ok, loaded.ok ? '' : loaded.error).toBe(true);
  if (!loaded.ok) throw new Error(loaded.error);
  expect(loaded.migrated).toEqual([]);
  expect(loaded.save.state).toEqual(state);
  return loaded.save.state;
}

describe('GAMES-ELEVATE-SESSION-UC-001: commander participation continuity', () => {
  it('uses schema 4 to prevent older builds ignoring deployment provenance, without rewriting schemas 2/3', () => {
    expect(SAVE_SCHEMA).toBe(4);
    const legacy = createGame(defaultSettings());
    delete legacy.settings.commanderTrainingCp;
    for (const schema of [2, 3]) {
      const restored = migrateSave(legacy, schema);
      expect(restored.ok).toBe(true);
      if (!restored.ok) continue;
      expect(restored.state).toEqual(legacy);
      expect(restored.notes).toEqual([]);
      expect(restored.state.settings.engagement).toBeUndefined();
      expect(restored.state.settings.commanderTrainingCp).toBeUndefined();
    }
  });

  it('resumes each side selection stage without spending CP or qualifying movement', () => {
    const fixture = battleFixture();
    let state = roundTrip(fixture.state);
    const cp = { ...state.cp };
    const anchors = state.armies.map(({ id, pos, at, movesLeft }) => ({ id, pos, at, movesLeft }));
    state = step(state, {
      type: 'engagementSelect',
      team: 'A',
      armyIds: [fixture.attacker, fixture.extraAttacker],
    });
    state = roundTrip(state);
    state = step(state, { type: 'engagementLock', team: 'A' });
    expect(state.pending!.participation!.stage).toBe('defender');
    state = roundTrip(state);
    state = step(state, {
      type: 'engagementSelect',
      team: 'B',
      armyIds: [fixture.defender, fixture.extraDefender],
    });
    state = roundTrip(step(state, { type: 'engagementLock', team: 'B' }));
    expect(state.cp).toEqual(cp);
    expect(state.armies.map(({ id, pos, at, movesLeft }) => ({ id, pos, at, movesLeft }))).toEqual(
      anchors,
    );
    const cancelled = step(state, { type: 'cancelBattle' });
    expect(cancelled.cp).toEqual(cp);
    expect(cancelled.armies).toEqual(state.armies);
    expect(cancelled.phase).toBe('strategic');
  });

  it.each([false, true])(
    'round-trips committed provenance, both deployment stages and combat (foundation=%s)',
    (foundation) => {
      const fixture = battleFixture(foundation);
      let state = ready(fixture);
      const cp = { ...state.cp };
      state = roundTrip(step(state, { type: 'startBattle' }));
      expect(state.cp).toEqual({ A: cp.A - 7, B: cp.B - 2 });
      expect(state.battle!.participationCosts).toEqual({ A: 7, B: 2 });
      expect(state.battle!.participants).toHaveLength(4);
      const committed = structuredClone(state);
      const replay = apply(state, { type: 'startBattle' });
      expect(replay.error).not.toBeNull();
      expect(replay.state).toEqual(committed);
      state = roundTrip(step(state, { type: 'finishDeploy' }));
      state = roundTrip(step(state, { type: 'finishDeploy' }));
      expect(state.battle!.phase).toBe('combat');
      for (const id of [fixture.extraAttacker, fixture.extraDefender]) {
        const holder = state.armies.find((army) => army.id === id)!;
        const before = fixture.state.armies.find((army) => army.id === id)!;
        expect([holder.pos, holder.at, holder.movesLeft]).toEqual([
          before.pos,
          before.at,
          before.movesLeft,
        ]);
      }
    },
  );

  it.each([false, true])(
    'retains pre-existing wounds in deployment and permits later tactical casualties (foundation=%s)',
    (foundation) => {
      const fixture = battleFixture(foundation);
      const holder = fixture.state.armies.find((army) => army.id === fixture.extraDefender)!;
      holder.units[0]!.hp = 3;
      let state = roundTrip(step(ready(fixture), { type: 'startBattle' }));
      const unitId = holder.units[0]!.id;
      expect(state.battle!.units.find((unit) => unit.id === unitId)!.hp).toBe(3);
      state = roundTrip(step(state, { type: 'finishDeploy' }));
      state = roundTrip(step(state, { type: 'finishDeploy' }));
      state.battle!.units.find((unit) => unit.id === unitId)!.hp = 0;
      state = roundTrip(state);
      state = roundTrip(step(state, { type: 'retreat' }));
      expect(state.battle!.phase).toBe('over');
    },
  );

  it('round-trips real auto-resolve results without another participation or creation charge', () => {
    const fixture = battleFixture();
    const pending = ready(fixture);
    const state = step(pending, { type: 'autoResolve' });
    expect(state.battle).toBeNull();
    expect(state.cp.A).toBe(pending.cp.A - 7);
    expect(state.cp.B).toBe(pending.cp.B - 2);
    roundTrip(state);
  });

  it('reopens attacker choices without carrying private defender additions into the new stage', () => {
    const fixture = battleFixture();
    let state = step(ready(fixture), {
      type: 'engagementSelect',
      team: 'A',
      armyIds: [fixture.attacker],
    });
    state = roundTrip(state);
    expect(state.pending!.participation).toEqual({
      attackerIds: [fixture.attacker],
      defenderIds: [fixture.defender],
      stage: 'attacker',
    });
  });

  it('restores foundation capture choices after defeated participant holders have been removed', () => {
    const fixture = battleFixture(true);
    let state = step(ready(fixture), { type: 'startBattle' });
    state = step(step(state, { type: 'finishDeploy' }), { type: 'finishDeploy' });
    const battle = state.battle!;
    for (const unit of battle.units) if (unit.team === battle.defender) unit.hp = 0;
    const center = battle.objective.captureKey!;
    const occupier =
      battle.units.find((unit) => unit.team === battle.attacker && unit.pos === center) ??
      battle.units.find((unit) => unit.team === battle.attacker && unit.hp > 0)!;
    occupier.pos = center;
    checkVictory(battle);
    state = roundTrip(step(state, { type: 'concludeBattle' }));
    expect(state.armies.some((army) => army.id === fixture.defender)).toBe(false);
    expect(state.armies.some((army) => army.id === fixture.extraDefender)).toBe(false);
    expect(state.infrastructure!.clock!.resolvingBattle?.participants).toHaveLength(4);
    expect(state.infrastructure!.capture.pending).not.toBeNull();
    for (const candidate of state.infrastructure!.capture.pending!.candidates)
      state = step(state, {
        type: 'captureChoice',
        nodeId: candidate.node.id,
        outcome: 'none',
      });
    state = roundTrip(step(state, { type: 'captureCommit' }));
    if (state.infrastructure!.garrisons!.pendingStationing)
      state = roundTrip(step(state, { type: 'stationingCommit' }));
    expect(state.battle).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.infrastructure!.clock!.completedBattleIds).toContain(battle.id);
  });

  it('retains extraction holder provenance before and after campaign writeback', () => {
    const fixture = battleFixture();
    let state = step(ready(fixture), { type: 'startBattle' });
    state = step(step(state, { type: 'finishDeploy' }), { type: 'finishDeploy' });
    const battle = state.battle!;
    for (const unit of battle.units) if (unit.team === battle.defender) unit.hp = 0;
    const captureKey = battle.objective.captureKey!;
    const occupier = battle.units.find((unit) => unit.team === battle.attacker && unit.hp > 0)!;
    occupier.pos = captureKey;
    state = roundTrip(step(state, { type: 'extract' }));
    expect(state.battle!.extracted).toBe(true);
    const extraIds = state.armies
      .find((army) => army.id === fixture.extraAttacker)!
      .units.map((unit) => unit.id);
    state = roundTrip(step(state, { type: 'concludeBattle' }));
    const extra = state.armies.find((army) => army.id === fixture.extraAttacker)!;
    expect(extra.units.map((unit) => unit.id)).toEqual(extraIds);
    const before = fixture.state.armies.find((army) => army.id === fixture.extraAttacker)!;
    expect([extra.pos, extra.movesLeft]).toEqual([before.pos, before.movesLeft]);
  });
});

describe('GAMES-ELEVATE-SESSION-UC-001: corrupted participation saves are rejected', () => {
  const corrupt = (state: GameState, mutation: (raw: any) => void, match: RegExp): void => {
    const raw = structuredClone(state);
    mutation(raw);
    const errors = validateGameState(raw);
    expect(errors.join('\n')).toMatch(match);
    expect(errors.join('\n')).not.toMatch(/validation crashed/);
    const loaded = deserializeSave(serializeSave(raw));
    expect(loaded.ok).toBe(false);
  };

  it('rejects missing profile fields, invalid prices, unknown profile fields and corrupt saved facing', () => {
    const state = battleFixture().state;
    for (const value of [
      null,
      {},
      { ...EXPERIMENTAL_ENGAGEMENT_PROFILE, attackBaseCp: 0 },
      { ...EXPERIMENTAL_ENGAGEMENT_PROFILE, additionalDefenderCp: -1 },
      { ...EXPERIMENTAL_ENGAGEMENT_PROFILE, additionalAttackerCp: Number.MAX_SAFE_INTEGER + 1 },
      { ...EXPERIMENTAL_ENGAGEMENT_PROFILE, moveFree: true },
    ]) {
      corrupt(
        state,
        (raw) => {
          raw.settings.engagement = value;
        },
        /settings\.engagement/,
      );
    }
    corrupt(
      state,
      (raw) => {
        raw.armies[0].units[0].facing = 6;
      },
      /facing/,
    );
  });

  it('rejects incomplete, wrong-side, premature or duplicate choices and shifted initial anchors', () => {
    const fixture = battleFixture();
    for (const mutation of [
      (raw: any) => {
        delete raw.pending.participation;
      },
      (raw: any) => {
        raw.pending.participation.stage = 'combat';
      },
      (raw: any) => {
        raw.pending.participation.attackerIds = [fixture.extraAttacker];
      },
      (raw: any) => {
        raw.pending.participation.attackerIds.push(fixture.attacker);
      },
      (raw: any) => {
        raw.pending.participation.attackerIds.push(fixture.extraDefender);
      },
      (raw: any) => {
        raw.pending.participation.defenderIds.push(fixture.extraDefender);
      },
      (raw: any) => {
        raw.cp.A = 0;
      },
      (raw: any) => {
        raw.pending.target = raw.hq.B;
      },
    ])
      corrupt(fixture.state, mutation, /participation|pending\.target/);
  });

  it('rejects forged committed anchors, changed movement, missing roster members and price receipts', () => {
    const fixture = battleFixture();
    const state = step(ready(fixture), { type: 'startBattle' });
    for (const mutation of [
      (raw: any) => {
        delete raw.battle.participants;
      },
      (raw: any) => {
        delete raw.battle.participationCosts;
      },
      (raw: any) => {
        raw.battle.participationCosts.A = 5;
      },
      (raw: any) => {
        raw.battle.participants.push(raw.battle.participants[0]);
      },
      (raw: any) => {
        raw.battle.participants[0].primary = false;
      },
      (raw: any) => {
        raw.battle.participants.find((part: any) => part.armyId === fixture.extraAttacker).pos =
          raw.hq.A;
      },
      (raw: any) => {
        raw.battle.participants.find(
          (part: any) => part.armyId === fixture.extraAttacker,
        ).movesLeft += 1;
      },
      (raw: any) => {
        raw.battle.units.pop();
      },
      (raw: any) => {
        delete raw.battle.units[0].holderId;
      },
      (raw: any) => {
        raw.pending.participation.attackerIds.pop();
      },
    ])
      corrupt(state, mutation, /participants|participationCosts|provenance|committed participant/);
  });

  it.each([false, true])(
    'rejects forged dead or altered-HP selected deployment rosters (foundation=%s)',
    (foundation) => {
      const fixture = battleFixture(foundation);
      let state = step(ready(fixture), { type: 'startBattle' });
      for (let stage = 0; stage < 2; stage++) {
        for (const holderId of [
          fixture.attacker,
          fixture.defender,
          fixture.extraAttacker,
          fixture.extraDefender,
        ]) {
          corrupt(
            state,
            (raw) => {
              for (const unit of raw.battle.units) if (unit.holderId === holderId) unit.hp = 0;
            },
            /deploying selected unit must match its living persistent source HP/,
          );
        }
        corrupt(
          state,
          (raw) => {
            raw.battle.units[0].hp -= 1;
          },
          /deploying selected unit must match its living persistent source HP/,
        );
        state = step(state, { type: 'finishDeploy' });
      }
    },
  );

  it('rejects deployment through a different commander even if that cell belongs to its team union', () => {
    const fixture = battleFixture();
    const state = step(ready(fixture), { type: 'startBattle' });
    const battle = state.battle!;
    const context = buildContext(state.settings, battle);
    const extra = battle.units.find((unit) => unit.holderId === fixture.extraAttacker)!;
    const own = new Set(deploymentZone(context, battle, extra.team, extra.holderId));
    const other = deploymentZone(context, battle, extra.team).find((key) => !own.has(key));
    expect(other).toBeDefined();
    corrupt(
      state,
      (raw) => {
        raw.battle.units.find((unit: any) => unit.id === extra.id).pos = other;
      },
      /own commander's deployment zone/,
    );
  });
});
