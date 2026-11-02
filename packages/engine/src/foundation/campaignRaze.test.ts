import { describe, expect, it } from 'vitest';
import { apply } from '../actions.ts';
import { createGame, defaultSettings, worldOf } from '../strategic.ts';
import { actionPoints, createBattle } from '../tactical.ts';
import { deserializeSave, serializeSave, validateGameState } from '../save.ts';
import type { GameState } from '../types.ts';
import type { FoundationCaptureBuilding } from './capture.ts';
import { campaignNodeEffects } from './campaign.ts';
import { campaignBuildingData, refreshCampaignNodeSnapshot } from './campaignNodes.ts';
import { createFoundationPlaytestConfiguration } from './playtestProfile.ts';
import {
  applyCampaignRazeTile,
  campaignRazeTileOptions,
  commitCampaignRazeTiles,
  quoteCampaignRazeTile,
  validateCampaignRazeTileState,
} from './campaignRaze.ts';

function fixture(stationed = false): {
  state: GameState;
  unitId: string;
  buildingId: string;
  nodeId: string;
} {
  const profile = createFoundationPlaytestConfiguration(25, 10);
  const configured = {
    ...profile,
    nodes: {
      ...profile.nodes,
      definitions: profile.nodes.definitions.map((definition) =>
        definition.id === 'workshop'
          ? {
              ...definition,
              exclusiveUpgrades: [{ id: 'production', cpCost: 1, engineerRequired: false }],
              slotlessUnlocks: [{ id: 'archive', cpCost: 1, engineerRequired: false }],
            }
          : definition,
      ),
    },
  };
  const state = createGame({
    ...defaultSettings(),
    grid: { mainCols: 4, mainRows: 3, subRadius: 3 },
    fog: false,
    controllers: { A: 'human', B: 'human' },
    infrastructure: configured,
  });
  const { world } = worldOf(state);
  const foundation = state.infrastructure!;
  const site = foundation.sites.find((site) => site.homeTeam === 'B')!;
  const buildingId = 'enemy-workshop';
  const subHex = site.annexSubHexes[0];
  state.infrastructure = {
    ...foundation,
    capture: {
      ...foundation.capture,
      nodes: foundation.capture.nodes.map((node) =>
        node.id !== site.nodeId
          ? node
          : {
              ...node,
              buildings: [
                ...node.buildings,
                {
                  id: buildingId,
                  ruined: false,
                  data: {
                    definitionId: 'workshop',
                    role: 'workshop',
                    specialty: 'industrial',
                    tier: 1,
                    placement: 'annex',
                    subHex,
                    active: true,
                    exclusiveChoices: ['production'],
                    unlocks: ['archive'],
                    equipmentIds: ['saved-kit'],
                  },
                },
              ],
            },
      ),
    },
  };
  const attacker = state.armies.find((army) => army.team === 'A' && army.kind === 'commander')!;
  const defender = state.armies.find((army) => army.team === 'B' && army.kind === 'commander')!;
  const unitId = attacker.units[0].id;
  if (stationed) {
    const [guard] = attacker.units.splice(0, 1);
    state.armies.push({
      id: 'test-tile-guard',
      team: 'A',
      kind: 'garrison',
      building: 'temporary',
      pos: subHex,
      at: site.mainHex,
      units: [guard],
      movesLeft: 0,
      stationedFacing: 4,
    });
  }
  const battle = createBattle(state, attacker, defender, attacker.at, defender.at, world);
  const used = new Set([subHex]);
  const cells = battle.mains
    .flatMap((main) => world.mainByKey.get(main)!.subKeys)
    .filter((key) => !used.has(key));
  for (const unit of battle.units) {
    unit.pos = unit.id === unitId ? subHex : cells.shift()!;
    unit.acted = false;
  }
  battle.phase = 'combat';
  battle.active = 'A';
  battle.round = 1;
  state.phase = 'battle';
  state.battle = battle;
  refreshCampaignNodeSnapshot(state);
  return { state, unitId, buildingId, nodeId: site.nodeId };
}
function target(state: GameState, nodeId: string, buildingId: string): FoundationCaptureBuilding {
  return state
    .infrastructure!.capture.nodes.find((node) => node.id === nodeId)!
    .buildings.find((building) => building.id === buildingId)!;
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: Raze Tile tactical command and battle commit', () => {
  it('spends one normal ACT in place, no CP or strategic work, and disables effects immediately', () => {
    const { state, unitId, buildingId, nodeId } = fixture();
    const original = JSON.stringify(state);
    const work = state.infrastructure!.capture.work;
    const cp = { ...state.cp };
    expect(quoteCampaignRazeTile(state, unitId, buildingId)).toMatchObject({
      eligible: true,
      actionCost: 1,
      cpCost: 0,
      label: 'Workshop',
    });
    expect(JSON.stringify(state)).toBe(original);
    expect(
      campaignRazeTileOptions(state, unitId).find((quote) => quote.buildingId === buildingId)
        ?.eligible,
    ).toBe(true);
    expect(
      campaignNodeEffects(state, nodeId).some((effect) => effect.buildingId === buildingId),
    ).toBe(true);
    const result = apply(state, { type: 'razeTile', unitId, buildingId });
    expect(result.error).toBeNull();
    const unit = result.state.battle!.units.find((unit) => unit.id === unitId)!;
    expect(unit).toMatchObject({
      acted: true,
      mp: 0,
      pos: state.battle!.units.find((unit) => unit.id === unitId)!.pos,
    });
    expect(actionPoints(unit).left).toBe(0);
    expect(result.state.cp).toEqual(cp);
    expect(result.state.infrastructure!.capture.work).toMatchObject({
      commandPoints: work.commandPoints,
      nodeSpending: work.nodeSpending,
      engineerSpending: work.engineerSpending,
      receipts: work.receipts,
    });
    expect(target(result.state, nodeId, buildingId).ruined).toBe(false);
    expect(result.state.battle!.ruinedInfrastructureBuildingIds).toEqual([buildingId]);
    expect(
      campaignNodeEffects(result.state, nodeId).some((effect) => effect.buildingId === buildingId),
    ).toBe(false);
    const again = apply(result.state, { type: 'razeTile', unitId, buildingId });
    expect(again.error).toBeTruthy();
    expect(again.state).toBe(result.state);
    expect(result.state.rng).toBe(state.rng);
  });

  it('permits the stationed-unit exception without movement or facing changes', () => {
    const { state, unitId, buildingId } = fixture(true);
    const before = { ...state.battle!.units.find((unit) => unit.id === unitId)! };
    expect(before).toMatchObject({ stationed: true, mp: 0, facing: 4 });
    expect(applyCampaignRazeTile(state, unitId, buildingId)).toEqual({ ok: true });
    expect(state.battle!.units.find((unit) => unit.id === unitId)).toMatchObject({
      pos: before.pos,
      facing: 4,
      stationed: true,
      mp: 0,
      acted: true,
    });
  });

  it('preserves pending tactical damage, AP and all building records across save/load and manual commit', () => {
    const prepared = fixture();
    const { unitId, buildingId, nodeId } = prepared;
    let state = prepared.state;
    const data = structuredClone(target(state, nodeId, buildingId).data);
    state = apply(state, { type: 'razeTile', unitId, buildingId }).state;
    expect(validateGameState(state)).toEqual([]);
    const loaded = deserializeSave(serializeSave(state));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    state = loaded.save.state;
    expect(state.battle!.ruinedInfrastructureBuildingIds).toEqual([buildingId]);
    expect(state.battle!.units.find((unit) => unit.id === unitId)).toMatchObject({
      acted: true,
      mp: 0,
    });
    expect(
      campaignNodeEffects(state, nodeId).some((effect) => effect.buildingId === buildingId),
    ).toBe(false);
    state.battle!.phase = 'over';
    state.battle!.winner = 'A';
    const committed = apply(state, { type: 'concludeBattle' });
    expect(committed.error).toBeNull();
    expect(target(committed.state, nodeId, buildingId)).toEqual({
      id: buildingId,
      ruined: true,
      data,
    });
    expect(campaignBuildingData(target(committed.state, nodeId, buildingId))).toMatchObject({
      tier: 1,
      exclusiveChoices: ['production'],
      unlocks: ['archive'],
      equipmentIds: ['saved-kit'],
    });
  });

  it('rejects wrong timing, ownership, reach, spent/dead units, centers and unrelated tile assets without mutation', () => {
    const cases: ((
      state: GameState,
      unitId: string,
      buildingId: string,
      nodeId: string,
    ) => { unitId: string; buildingId: string })[] = [
      (state, unitId, buildingId) => {
        state.battle!.phase = 'deploy';
        return { unitId, buildingId };
      },
      (state, unitId, buildingId) => {
        state.battle!.active = 'B';
        return { unitId, buildingId };
      },
      (state, unitId, buildingId) => {
        state.battle!.units.find((unit) => unit.id === unitId)!.hp = 0;
        return { unitId, buildingId };
      },
      (state, unitId, buildingId) => {
        state.battle!.units.find((unit) => unit.id === unitId)!.acted = true;
        return { unitId, buildingId };
      },
      (state, unitId, buildingId) => {
        state.battle!.units.find((unit) => unit.id === unitId)!.pos = state.battle!.units.find(
          (unit) => unit.id !== unitId,
        )!.pos;
        return { unitId, buildingId };
      },
      (state, unitId, buildingId, nodeId) => {
        state.infrastructure = {
          ...state.infrastructure!,
          capture: {
            ...state.infrastructure!.capture,
            nodes: state.infrastructure!.capture.nodes.map((node) =>
              node.id === nodeId ? { ...node, owner: 'A' } : node,
            ),
          },
        };
        return { unitId, buildingId };
      },
      (state, unitId, _buildingId, nodeId) => ({
        unitId,
        buildingId: state.infrastructure!.capture.nodes.find((node) => node.id === nodeId)!
          .buildings[0].id,
      }),
      (_state, unitId) => ({ unitId, buildingId: 'road-or-fort' }),
      (state, unitId, buildingId) => {
        state.battle!.ruinedInfrastructureBuildingIds = [buildingId];
        return { unitId, buildingId };
      },
    ];
    for (const change of cases) {
      const { state, unitId, buildingId, nodeId } = fixture();
      const request = change(state, unitId, buildingId, nodeId);
      const before = JSON.stringify(state);
      expect(applyCampaignRazeTile(state, request.unitId, request.buildingId).ok).toBe(false);
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it('rejects malformed, duplicate, unknown and center ruin references before damage commit', () => {
    for (const kind of ['duplicate', 'unknown', 'center', 'sparse'] as const) {
      const { state, buildingId, nodeId } = fixture();
      state.battle!.phase = 'over';
      state.battle!.winner = 'A';
      state.battle!.ruinedInfrastructureBuildingIds =
        kind === 'duplicate'
          ? [buildingId, buildingId]
          : kind === 'unknown'
            ? ['unknown']
            : kind === 'center'
              ? [
                  state.infrastructure!.capture.nodes.find((node) => node.id === nodeId)!
                    .buildings[0].id,
                ]
              : new Array(1);
      expect(validateCampaignRazeTileState(state)).toBeTruthy();
      const before = JSON.stringify(state);
      expect(commitCampaignRazeTiles(state, state.battle!).ok).toBe(false);
      expect(JSON.stringify(state)).toBe(before);
    }
  });
});
