// GAMES-ELEVATE-CAMPAIGN-TS-018: in-battle road work keeps strategic receipts through round/reload/writeback.
import { describe, expect, it } from 'vitest';
import {
  apply,
  aiStep,
  createGame,
  defaultSettings,
  createBattle,
  contextFor,
  deserializeSave,
  serializeSave,
  validateGameState,
  createFoundationPlaytestConfiguration,
  refreshCampaignNodeSnapshot,
  worldOf,
  setHolderPos,
  hexKey,
  neighbors,
  unitType,
  stepCost,
  hexDistance,
  parseKey,
  constructCampaignNodeRequest,
  constructCampaignRoadRepairRequest,
  quoteCampaignRoadRepair,
  workingCampaignRoads,
  campaignRoadRepairOptions,
} from '../index.ts';
import type { GameState, Team } from '../types.ts';
import type { GameAction } from '../actions.ts';

function step(state: GameState, action: GameAction): GameState {
  const result = apply(state, action);
  expect(result.error).toBeNull();
  expect(validateGameState(result.state)).toEqual([]);
  return result.state;
}
function restore(state: GameState): GameState {
  const result = deserializeSave(serializeSave(state));
  if (!result.ok) throw new Error(result.error);
  expect(result.save.state).toEqual(state);
  return result.save.state;
}
/** Prepared battle opening; every subsequent repair, round, retreat and writeback uses GameActions. */
function fixture(): { state: GameState; engineer: string; defenderEngineer: string } {
  const settings = {
    ...defaultSettings(),
    seed: 1,
    grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
    controllers: { A: 'human' as const, B: 'human' as const },
    fog: false,
    commanderTrainingCp: 11,
  };
  const profile = { ...createFoundationPlaytestConfiguration(7, 3), roadRepairCp: 4 };
  const preview = createGame({ ...settings, infrastructure: profile });
  const { world, terrain } = worldOf(preview);
  const roads = (['A', 'B'] as Team[]).flatMap((team) => {
    const main = world.mainByKey.get(preview.hq[team])!;
    const edges = main.subKeys.flatMap((from) =>
      neighbors(world.subByKey.get(from)!.hex)
        .map(hexKey)
        .filter(
          (to) =>
            world.subByKey.get(to)?.main === main.key &&
            Math.abs(
              terrain.heights[world.subByKey.get(to)!.index]! -
                terrain.heights[world.subByKey.get(from)!.index]!,
            ) <= 2,
        )
        .map((to) => [from, to]),
    );
    return [0, 1].map((index) => ({
      id: `road-${team}-${index}`,
      mainHex: main.key,
      path: edges[index]!,
      damaged: true,
    }));
  });
  const state = createGame({ ...settings, infrastructure: { ...profile, roads } });
  const a = state.armies.find((holder) => holder.team === 'A' && holder.kind === 'commander')!;
  const b = state.armies.find((holder) => holder.team === 'B' && holder.kind === 'commander')!;
  const middle = world.mains.find((main) => main.col === 1 && main.row === 1)!;
  setHolderPos(world, b, hexKey(middle.center));
  const battle = createBattle(state, a, b, a.at, b.at, world);
  const engineer = a.units.find((unit) => unitType(unit.typeId).engineer)!.id;
  const defenderEngineer = b.units.find((unit) => unitType(unit.typeId).engineer)!.id;
  const reserved = new Set<string>([
    roads.find((road) => road.id === 'road-A-0')!.path[0]!,
    roads.find((road) => road.id === 'road-B-0')!.path[0]!,
  ]);
  for (const unit of battle.units) {
    const road = roads.find((road) => road.id === `road-${unit.team}-0`)!;
    const cells =
      unit.id === engineer || unit.id === defenderEngineer
        ? [road.path[0]!]
        : world.mainByKey.get(unit.team === 'A' ? state.hq.A : middle.key)!.subKeys;
    unit.pos =
      unit.id === engineer || unit.id === defenderEngineer
        ? cells[0]!
        : cells.find((cell) => !reserved.has(cell))!;
    if (!unit.pos) throw new Error('Prepared battle ran out of cells');
    reserved.add(unit.pos);
    unit.acted = false;
  }
  battle.phase = 'combat';
  battle.active = 'A';
  battle.round = 1;
  state.phase = 'battle';
  state.battle = battle;
  refreshCampaignNodeSnapshot(state);
  expect(validateGameState(state)).toEqual([]);
  return { state, engineer, defenderEngineer };
}
function repair(state: GameState, roadId: string, engineerId: string): GameAction {
  return {
    type: 'repairRoad',
    request: constructCampaignRoadRepairRequest(state, roadId, engineerId),
  };
}
function rejection(state: GameState, action: GameAction, reason: string): void {
  const before = structuredClone(state);
  const result = apply(state, action);
  expect(result.error).toContain(reason);
  expect(result.state).toEqual(before);
  expect(state).toEqual(before);
}
function finishChoices(input: GameState): GameState {
  let state = input;
  for (let guard = 0; guard < 30; guard++) {
    const f = state.infrastructure!;
    if (f.capture.pending) {
      for (const candidate of f.capture.pending.candidates)
        state = step(state, { type: 'captureChoice', nodeId: candidate.node.id, outcome: 'none' });
      state = step(state, { type: 'captureCommit' });
    } else if (f.garrisons?.pendingStationing) state = step(state, { type: 'stationingCommit' });
    else if (f.garrisons?.freeShots.pending) {
      const action = aiStep(state);
      if (!action) throw new Error('No pending shot action');
      state = step(state, action);
    } else return state;
  }
  throw new Error('Pending choices did not settle');
}

describe('GAMES-ELEVATE-CAMPAIGN-TS-018: approved tactical road repair', () => {
  it('spends configured CP, normal ACT/all movement and persistent engineering outside node work; road benefit resumes immediately', () => {
    const { state, engineer } = fixture();
    const before = structuredClone(state);
    const road = state.infrastructure!.supply!.roads[0]!;
    const raw = stepCost(
      contextFor(state),
      road.path[0]!,
      road.path[1]!,
      unitType('ww2_engineer').maxClimb,
    )!;
    expect(raw).toBeGreaterThan(0);
    expect(quoteCampaignRoadRepair(state, road.id, engineer)).toMatchObject({
      allowed: true,
      cpCost: 4,
    });
    expect(state).toEqual(before);
    const action = repair(state, road.id, engineer);
    const result = step(state, action);
    expect(result.cp.A).toBe(state.cp.A - 4);
    expect(result.battle!.units.find((unit) => unit.id === engineer)).toMatchObject({
      acted: true,
      mp: 0,
    });
    expect(result.infrastructure!.capture.work.nodeSpending).toEqual(
      state.infrastructure!.capture.work.nodeSpending,
    );
    expect(result.infrastructure!.capture.work.engineerSpending).toContainEqual(
      expect.objectContaining({
        unitId: engineer,
        ownerTurnId: state.infrastructure!.ownerTurns.A,
      }),
    );
    expect(result.infrastructure!.supply!.roads[0]!.damaged).toBe(true);
    expect(workingCampaignRoads(result)[0]!.damaged).toBe(false);
    expect(
      stepCost(contextFor(result), road.path[0]!, road.path[1]!, unitType('ww2_engineer').maxClimb),
    ).toBeCloseTo(raw * state.infrastructure!.configuration!.supply.roadMultiplier);
    expect(result.infrastructure!.clock!.paidIncomeEvents).toEqual(
      state.infrastructure!.clock!.paidIncomeEvents,
    );
    expect(result.infrastructure!.supply!.reinforcement).toEqual(
      state.infrastructure!.supply!.reinforcement,
    );
    expect(step(result, action)).toEqual(result);
    expect(restore(result)).toEqual(result);
  });
  it('does not replenish strategic engineering when normal tactical ACT/movement refresh or save reload occurs', () => {
    const { state: initial, engineer } = fixture();
    let state = step(initial, repair(initial, 'road-A-0', engineer));
    state = step(state, { type: 'endBattleTurn' });
    state = step(state, { type: 'endBattleTurn' });
    state = restore(state);
    expect(state.battle!.units.find((unit) => unit.id === engineer)!.acted).toBe(false);
    expect(state.battle!.units.find((unit) => unit.id === engineer)!.mp).toBeGreaterThan(0);
    rejection(state, repair(state, 'road-A-1', engineer), 'used its strategic action');
  });
  it('uses the defending team owner cycle and CP instead of charging the strategic attacker', () => {
    const { state: initial, defenderEngineer } = fixture();
    const state = step(initial, { type: 'endBattleTurn' });
    expect(state.active).toBe('A');
    expect(state.battle!.active).toBe('B');
    const result = step(state, repair(state, 'road-B-0', defenderEngineer));
    expect(result.cp.A).toBe(state.cp.A);
    expect(result.cp.B).toBe(state.cp.B - 4);
    expect(result.infrastructure!.capture.work.engineerSpending).toContainEqual(
      expect.objectContaining({
        unitId: defenderEngineer,
        team: 'B',
        ownerTurnId: state.infrastructure!.ownerTurns.B,
      }),
    );
  });
  it('rejects ACT, CP, roster, life, location, stale and target failures atomically for the intended reason', () => {
    for (const kind of [
      'acted',
      'cp',
      'infantry',
      'dead',
      'remote',
      'wrong-team',
      'wrong-cycle',
      'stale',
      'unknown',
    ] as const) {
      const { state, engineer } = fixture();
      const unit = state.battle!.units.find((unit) => unit.id === engineer)!;
      expect(quoteCampaignRoadRepair(state, 'road-A-0', engineer).allowed).toBe(true);
      let action = repair(state, 'road-A-0', engineer);
      let reason = '';
      if (kind === 'acted') {
        unit.acted = true;
        reason = 'tactical ACT';
      }
      if (kind === 'cp') {
        state.cp.A = 3;
        refreshCampaignNodeSnapshot(state);
        action = repair(state, 'road-A-0', engineer);
        reason = 'Not enough command points';
      }
      if (kind === 'infantry') {
        unit.typeId = 'ww2_rifle_infantry';
        reason = 'living friendly deployed engineer';
      }
      if (kind === 'dead') {
        unit.hp = 0;
        reason = 'living friendly deployed engineer';
      }
      if (kind === 'remote') {
        unit.pos = worldOf(state)
          .world.mainByKey.get(state.hq.B)!
          .subKeys.find((key) => !state.battle!.units.some((other) => other.pos === key))!;
        reason = 'in this MainHex';
      }
      if (kind === 'wrong-team' && action.type === 'repairRoad') {
        action = {
          ...action,
          request: {
            ...action.request,
            engineerUnitId: state.battle!.units.find(
              (other) => other.team === 'B' && unitType(other.typeId).engineer,
            )!.id,
          },
        };
        reason = 'living friendly deployed engineer';
      }
      if (kind === 'wrong-cycle' && action.type === 'repairRoad') {
        action = { ...action, request: { ...action.request, ownerTurnId: 'A:wrong' } };
        reason = 'current owner turn';
      }
      if (kind === 'stale' && action.type === 'repairRoad') {
        action = {
          ...action,
          request: { ...action.request, expectedVersion: action.request.expectedVersion + 1 },
        };
        reason = 'snapshot is stale';
      }
      if (kind === 'unknown' && action.type === 'repairRoad') {
        action = { ...action, request: { ...action.request, roadId: 'missing-road' } };
        reason = 'Unknown or ambiguous';
      }
      rejection(state, action, reason);
    }
  });
  it('commits working road state on real retreat/writeback, keeps spend until the next strategic owner turn', () => {
    const { state: initial, engineer } = fixture();
    let state = step(initial, repair(initial, 'road-A-0', engineer));
    state = step(state, { type: 'retreat' });
    state = finishChoices(step(state, { type: 'concludeBattle' }));
    state = restore(state);
    expect(state.phase).toBe('strategic');
    expect(state.infrastructure!.supply!.roads[0]!.damaged).toBe(false);
    rejection(state, repair(state, 'road-A-1', engineer), 'used its strategic action');
    const oldCycle = state.infrastructure!.ownerTurns.A;
    state = finishChoices(step(state, { type: 'endTurn' }));
    state = finishChoices(step(state, { type: 'endTurn' }));
    expect(state.infrastructure!.ownerTurns.A).not.toBe(oldCycle);
    expect(quoteCampaignRoadRepair(state, 'road-A-1', engineer).allowed).toBe(true);
    state = step(state, repair(state, 'road-A-1', engineer));
    expect(
      state.infrastructure!.capture.work.engineerSpending.filter(
        (spend) => spend.unitId === engineer,
      ),
    ).toHaveLength(2);
  });
  it('permits tactical road repair after both ordinary and engineer-funded node building operations are exhausted', () => {
    const prepared = fixture();
    let state = prepared.state;
    const battle = state.battle!;
    state.battle = null;
    state.phase = 'strategic';
    state = step(state, { type: 'recruit', typeId: 'ww2_engineer' });
    const engineer = state.armies
      .find((holder) => holder.team === 'A' && holder.kind === 'garrison')!
      .units.find((unit) => unitType(unit.typeId).engineer)!;
    const site = state.infrastructure!.sites.find((site) => site.homeTeam === 'A')!;
    for (let i = 0; i < 2; i++)
      state = step(state, {
        type: 'nodeWork',
        request: constructCampaignNodeRequest(state, {
          kind: 'build',
          nodeId: site.nodeId,
          definitionId: 'workshop',
          subHex: site.annexSubHexes[i]!,
          tier: 1,
          engineerUnitId: i === 0 ? null : engineer.id,
        }),
      });
    const nodeSpend = structuredClone(state.infrastructure!.capture.work.nodeSpending);
    expect(nodeSpend.find((spend) => spend.nodeId === site.nodeId)!.operationCount).toBe(2);
    state.phase = 'battle';
    state.battle = battle;
    expect(validateGameState(state)).toEqual([]);
    expect(quoteCampaignRoadRepair(state, 'road-A-0', prepared.engineer).allowed).toBe(true);
    const result = step(state, repair(state, 'road-A-0', prepared.engineer));
    expect(result.infrastructure!.capture.work.nodeSpending).toEqual(nodeSpend);
  });
  it('updates the actual tactical movement consumer for another unit immediately after engineering', () => {
    const { state: initial, engineer } = fixture();
    const { world } = worldOf(initial);
    const road = initial.infrastructure!.supply!.roads[0]!;
    const person = initial.battle!.units.find((unit) => unit.id === engineer)!;
    const follower = initial.battle!.units.find(
      (unit) => unit.team === 'A' && unit.id !== engineer,
    )!;
    const oldPos = follower.pos;
    follower.pos = road.path[0]!;
    person.pos = oldPos;
    const blocker = initial.battle!.units.find((unit) => unit.pos === road.path[1]);
    if (blocker)
      blocker.pos = world.mainByKey
        .get(initial.hq.A)!
        .subKeys.find((key) => !initial.battle!.units.some((unit) => unit.pos === key))!;
    expect(validateGameState(initial)).toEqual([]);
    const raw = stepCost(
      contextFor(initial),
      road.path[0]!,
      road.path[1]!,
      unitType(follower.typeId).maxClimb,
    )!;
    let state = step(initial, repair(initial, road.id, engineer));
    const before = state.battle!.units.find((unit) => unit.id === follower.id)!.mp;
    state = step(state, { type: 'move', unitId: follower.id, cell: road.path[1]! });
    expect(state.battle!.units.find((unit) => unit.id === follower.id)!.mp).toBeCloseTo(
      before - raw * initial.infrastructure!.configuration!.supply.roadMultiplier,
    );
  });
  it('allows a stationed engineer to repair in place using ACT without gaining movement orders', () => {
    const { state: initial, engineer } = fixture();
    const holder = initial.armies.find((holder) =>
      holder.units.some((unit) => unit.id === engineer),
    )!;
    const person = holder.units.find((unit) => unit.id === engineer)!;
    holder.units = holder.units.filter((unit) => unit.id !== engineer);
    const unit = initial.battle!.units.find((unit) => unit.id === engineer)!;
    const guardId = 'stationed-road-engineer';
    initial.armies.push({
      id: guardId,
      kind: 'garrison',
      building: 'temporary',
      team: 'A',
      at: initial.hq.A,
      pos: unit.pos!,
      units: [person],
      movesLeft: 0,
      stationedFacing: unit.facing,
    });
    unit.holderId = guardId;
    unit.stationed = true;
    unit.mp = 0;
    expect(validateGameState(initial)).toEqual([]);
    const beforePos = unit.pos;
    const result = step(initial, repair(initial, 'road-A-0', engineer));
    expect(result.battle!.units.find((unit) => unit.id === engineer)).toMatchObject({
      stationed: true,
      acted: true,
      mp: 0,
      pos: beforePos,
    });
    expect(result.armies.find((holder) => holder.id === guardId)!.movesLeft).toBe(0);
    expect(result.cp.A).toBe(initial.cp.A - 4);
    expect(restore(result)).toEqual(result);
  });
  it('rejects corrupt repair overlays on load and shares the same legal action options with AI', () => {
    const { state: initial, engineer } = fixture();
    const state = step(initial, repair(initial, 'road-A-0', engineer));
    for (const record of [
      { roadId: 'missing', requestId: 'bad' },
      state.battle!.repairedInfrastructureRoads![0]!,
    ]) {
      const bad = structuredClone(state);
      bad.battle!.repairedInfrastructureRoads!.push(record);
      expect(deserializeSave(serializeSave(bad))).toMatchObject({ ok: false });
    }
    expect(
      campaignRoadRepairOptions(initial).some(
        (quote) => quote.allowed && quote.engineerUnitId === engineer,
      ),
    ).toBe(true);
    const noShoot = structuredClone(initial);
    noShoot.battle!.units = noShoot.battle!.units.map((unit) =>
      unit.team === 'A' && unit.id !== engineer ? { ...unit, acted: true } : unit,
    );
    const world = worldOf(noShoot).world;
    const engineerPos = noShoot.battle!.units.find((unit) => unit.id === engineer)!.pos!;
    const distant = world.mainByKey
      .get(noShoot.hq.B)!
      .subKeys.slice()
      .sort(
        (a, b) =>
          hexDistance(parseKey(b), parseKey(engineerPos)) -
          hexDistance(parseKey(a), parseKey(engineerPos)),
      );
    noShoot.battle!.units = noShoot.battle!.units.map((unit) =>
      unit.team === 'B' ? { ...unit, pos: distant.shift()! } : unit,
    );
    expect(validateGameState(noShoot)).toEqual([]);
    // Legal far-away enemies prevent an immediate shot without fabricating undeployed combatants.
    const action = aiStep(noShoot);
    expect(action?.type).toBe('repairRoad');
    if (action) expect(apply(noShoot, action).error).toBeNull();
  });
});
