import { describe, expect, it } from 'vitest';
import { buildWorld } from '../grid.ts';
import { hexKey, neighbor } from '../hex.ts';
import { transferUnits } from '../command.ts';
import { deserializeSave, serializeSave } from '../save.ts';
import {
  createGame,
  defaultSettings,
  garrisonOf,
  makeUnit,
  setHolderPos,
  worldOf,
} from '../strategic.ts';
import type { GameState } from '../types.ts';
import { unitType } from '../units.ts';
import {
  applyCampaignNodeAction,
  constructCampaignNodeRequest,
  refreshCampaignNodeSnapshot,
} from './campaignNodes.ts';
import {
  applyCampaignRoadRepair,
  campaignRoadRepairOptions,
  constructCampaignRoadRepairRequest,
  quoteCampaignRoadRepair,
} from './campaignRoads.ts';
import type { CampaignRoadRepairRequest } from './campaignRoads.ts';
import { createFoundationPlaytestConfiguration } from './playtestProfile.ts';

function game(enemyRoad = false): GameState {
  const settings = {
    ...defaultSettings(),
    seed: 1,
    controllers: { A: 'human' as const, B: 'human' as const },
    grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
  };
  const world = buildWorld(settings.grid);
  const main = world.mains.find((cell) => cell.col === (enemyRoad ? 2 : 0) && cell.row === 1)!;
  const center = hexKey(main.center);
  const configuration = {
    ...createFoundationPlaytestConfiguration(7, 3),
    roadRepairCp: 2,
    roads: [0, 1].map((direction) => ({
      id: `road-${direction}`,
      mainHex: main.key,
      path: [center, hexKey(neighbor(main.center, direction))],
      damaged: true,
    })),
  };
  const state = createGame({ ...settings, infrastructure: configuration });
  state.cp.A = 100;
  refreshCampaignNodeSnapshot(state);
  return state;
}
function engineer(state: GameState): { id: string; holderId: string } {
  const holder = state.armies.find((army) => army.team === 'A' && army.kind === 'commander')!;
  return {
    id: holder.units.find((unit) => unitType(unit.typeId).engineer)!.id,
    holderId: holder.id,
  };
}
function request(state: GameState, roadId = 'road-0'): CampaignRoadRepairRequest {
  return constructCampaignRoadRepairRequest(state, roadId, engineer(state).id);
}
function reject(state: GameState, repair: CampaignRoadRepairRequest, expected: string): void {
  const before = structuredClone(state);
  expect(applyCampaignRoadRepair(state, repair)).toMatchObject({
    ok: false,
    error: expect.stringContaining(expected),
  });
  expect(state).toEqual(before);
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: real road repair boundary', () => {
  it('repairs an explicit map section with one CP debit and engineer action, using no node work', () => {
    const state = game();
    expect(state.infrastructure!.supply!.roads).toHaveLength(2);
    const before = structuredClone(state);
    const repair = request(state);
    expect(applyCampaignRoadRepair(state, repair)).toMatchObject({
      ok: true,
      replayed: false,
      receipt: {
        cpSpent: 2,
        nodeId: null,
        nodeOperationsSpent: 0,
        allowance: 'engineer',
        engineerUnitId: engineer(before).id,
      },
    });
    expect(state.cp.A).toBe(98);
    expect(state.infrastructure!.capture.version).toBe(before.infrastructure!.capture.version + 1);
    expect(state.infrastructure!.capture.work.nodeSpending).toEqual(
      before.infrastructure!.capture.work.nodeSpending,
    );
    expect(state.infrastructure!.capture.work.engineerSpending).toHaveLength(1);
    expect(state.infrastructure!.supply!.roads.map((road) => road.damaged)).toEqual([false, true]);
    expect(state.infrastructure!.supply!.reinforcement).toEqual(
      before.infrastructure!.supply!.reinforcement,
    );
    expect(state.nextId).toBe(before.nextId);
  });

  it('replays exactly once and preserves spent engineer allowance across real save/load', () => {
    const state = game();
    const repair = request(state);
    expect(applyCampaignRoadRepair(state, repair).ok).toBe(true);
    const saved = deserializeSave(serializeSave(state));
    if (!saved.ok) throw new Error(saved.error);
    const loaded = saved.save.state;
    const before = structuredClone(loaded);
    expect(applyCampaignRoadRepair(loaded, repair)).toMatchObject({ ok: true, replayed: true });
    expect(loaded).toEqual(before);
    reject(
      loaded,
      { ...request(loaded, 'road-1'), engineerUnitId: repair.engineerUnitId },
      'used its strategic action',
    );
    reject(loaded, { ...repair, roadId: 'road-1' }, 'belongs to different work');
  });

  it('allows a garrisoned engineer without granting movement or consuming building operations', () => {
    const state = game();
    const person = engineer(state);
    const hq = garrisonOf(state, 'A')!;
    expect(transferUnits(state, person.holderId, hq.id, [person.id])).toMatchObject({ ok: true });
    const repair = constructCampaignRoadRepairRequest(state, 'road-0', person.id);
    expect(applyCampaignRoadRepair(state, repair).ok).toBe(true);
    expect(hq.movesLeft).toBe(0);
    expect(state.infrastructure!.capture.work.nodeSpending).toEqual([]);
  });

  it('allows engineering in the MainHex without requiring territorial or node ownership', () => {
    const state = game(true);
    const person = engineer(state);
    const holder = state.armies.find((army) => army.id === person.holderId)!;
    const road = state.infrastructure!.supply!.roads[0];
    setHolderPos(worldOf(state).world, holder, road.path[1]);
    expect(
      state.infrastructure!.capture.nodes.find((node) => node.mainHex === road.mainHex)!.owner,
    ).toBe('B');
    expect(applyCampaignRoadRepair(state, request(state)).ok).toBe(true);
    expect(
      state.infrastructure!.capture.nodes.find((node) => node.mainHex === road.mainHex)!.owner,
    ).toBe('B');
  });

  it('permits road work after the node has spent both building operations', () => {
    const state = game();
    const person = engineer(state);
    const holder = state.armies.find((army) => army.id === person.holderId)!;
    const extra = makeUnit(state, 'A', 'ww2_engineer');
    holder.units.push(extra);
    const site = state.infrastructure!.sites.find((candidate) => candidate.homeTeam === 'A')!;
    for (let i = 0; i < 2; i++) {
      const build = constructCampaignNodeRequest(state, {
        kind: 'build',
        nodeId: site.nodeId,
        definitionId: 'workshop',
        subHex: site.annexSubHexes[i],
        tier: 1,
        engineerUnitId: i === 0 ? null : person.id,
      });
      expect(applyCampaignNodeAction(state, worldOf(state).world, build)).toMatchObject({
        ok: true,
      });
    }
    const before = structuredClone(state.infrastructure!.capture.work.nodeSpending);
    expect(before[0].operationCount).toBe(2);
    expect(
      applyCampaignRoadRepair(state, constructCampaignRoadRepairRequest(state, 'road-0', extra.id)),
    ).toMatchObject({ ok: true });
    expect(state.infrastructure!.capture.work.nodeSpending).toEqual(before);
  });

  it('quotes the actual mutator and exposes engineer-specific reasons without spending', () => {
    const state = game();
    const before = structuredClone(state);
    const quote = quoteCampaignRoadRepair(state, 'road-0', engineer(state).id);
    expect(quote).toMatchObject({ allowed: true, reason: null, roadId: 'road-0', cpCost: 2 });
    expect(quote.request).toEqual(request(state));
    expect(campaignRoadRepairOptions(state)).toHaveLength(2);
    expect(state).toEqual(before);
    expect(applyCampaignRoadRepair(state, quote.request!).ok).toBe(true);
    expect(campaignRoadRepairOptions(state)[0]).toMatchObject({
      roadId: 'road-1',
      allowed: false,
      reason: expect.stringContaining('used its strategic action'),
    });
  });

  it('rejects stale requests, insufficient CP, wrong roster and dead engineers without mutation', () => {
    const state = game();
    const repair = request(state);
    reject(state, { ...repair, expectedVersion: repair.expectedVersion + 1 }, 'snapshot is stale');
    const infantry = state.armies
      .find((army) => army.id === engineer(state).holderId)!
      .units.find((unit) => !unitType(unit.typeId).engineer)!;
    reject(state, { ...repair, engineerUnitId: infantry.id }, 'living, friendly');
    state.cp.A = 0;
    refreshCampaignNodeSnapshot(state);
    reject(state, request(state), 'Not enough command points');
    state.cp.A = 100;
    refreshCampaignNodeSnapshot(state);
    const person = engineer(state);
    state.armies
      .find((army) => army.id === person.holderId)!
      .units.find((unit) => unit.id === person.id)!.hp = 0;
    reject(state, request(state), 'living, friendly');
    expect(campaignRoadRepairOptions(state)[0]).toMatchObject({
      allowed: false,
      request: null,
      engineerUnitId: null,
    });
  });

  it('does not accept a remote engineer or invent an already operational repair target', () => {
    const state = game(true);
    reject(state, request(state), 'in this MainHex');
    const own = game();
    const f = own.infrastructure!;
    own.infrastructure = {
      ...f,
      supply: { ...f.supply!, roads: f.supply!.roads.map((road) => ({ ...road, damaged: false })) },
    };
    reject(own, request(own), 'not damaged');
    expect(campaignRoadRepairOptions(own)).toEqual([]);
  });
});
