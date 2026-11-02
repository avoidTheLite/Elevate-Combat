import { describe, expect, it } from 'vitest';
import { apply } from '../actions.ts';
import { strategicAiStep } from '../ai/strategicAi.ts';
import { chooseCampaignFreeShotAiTarget, tacticalAiStep } from '../ai/tacticalAi.ts';
import { withTerrainOverride } from '../battleMap.ts';
import { aiStep, isAiTurn } from '../runner.ts';
import { hexDistance } from '../hex.ts';
import {
  COMMAND,
  createGame,
  defaultSettings,
  fortify,
  garrisonOf,
  makeUnit,
  recruit,
  setHolderPos,
  worldOf,
} from '../strategic.ts';
import { generateTerrain } from '../terrain.ts';
import { flatBattle, mkUnit } from '../testBattle.ts';
import type { ArmyUnit, GameState } from '../types.ts';
import { unitType } from '../units.ts';
import type { CampaignBuildingEffects, CampaignConfiguration } from './campaign.ts';
import { beginCampaignOwnerTurn, resumeCampaignTurnStart } from './campaign.ts';
import {
  campaignBuildingData,
  campaignNodeActionChoices,
  chooseCampaignCapture,
  commitCampaignCapture,
  prepareCampaignCapture,
  refreshCampaignNodeSnapshot,
} from './campaignNodes.ts';
import {
  beginCampaignFreeShots,
  campaignFreeShotPrompt,
  campaignGarrisonTargetOptions,
} from './campaignGarrisons.ts';
import { createFoundationPlaytestConfiguration } from './playtestProfile.ts';
import { campaignRazeTileOptions } from './campaignRaze.ts';

function legacyGame(): GameState {
  const state = createGame({
    ...defaultSettings(),
    seed: 1,
    fog: false,
    grid: { mainCols: 5, mainRows: 3, subRadius: 2 },
    controllers: { A: 'human', B: 'human' },
  });
  state.cp.A = 100;
  for (const army of state.armies)
    army.units = army.units.filter((u) => !unitType(u.typeId).engineer);
  return state;
}

function game(effects: Partial<CampaignBuildingEffects> = {}): GameState {
  const base = createFoundationPlaytestConfiguration(7, 3);
  const configuration: CampaignConfiguration = {
    ...base,
    effects: {
      ...base.effects,
      generic: Object.fromEntries(
        Object.entries(base.effects.generic).map(([tier, original]) => [
          tier,
          { ...original, ...effects },
        ]),
      ),
    },
  };
  const state = createGame({
    ...defaultSettings(),
    seed: 1,
    fog: false,
    grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
    controllers: { A: 'human', B: 'human' },
    infrastructure: configuration,
  });
  state.cp.A = 100;
  refreshCampaignNodeSnapshot(state);
  return state;
}

function fillHome(state: GameState): void {
  garrisonOf(state, 'A')!.units = Array.from({ length: COMMAND.garrisonCap }, () =>
    makeUnit(state, 'A', 'ww2_rifle_infantry'),
  );
}

function flat<T>(run: () => T): T {
  return withTerrainOverride((world, seed) => {
    const terrain = generateTerrain(world, seed);
    terrain.heights.fill(2);
    return terrain;
  }, run);
}

function claimCity(state: GameState, owner: 'A' | 'B' = 'A'): string {
  const f = state.infrastructure!;
  const site = f.sites.find(
    (s) => s.homeTeam === null && !state.armies.some((a) => a.at === s.mainHex && a.units.length),
  )!;
  state.infrastructure = {
    ...f,
    capture: {
      ...f.capture,
      nodes: f.capture.nodes.map((node) =>
        node.id === site.nodeId
          ? {
              ...node,
              owner,
              buildings: node.buildings.map((building) => ({
                ...building,
                data: { ...campaignBuildingData(building), active: true, tier: 2 },
              })),
            }
          : node,
      ),
    },
  };
  return site.nodeId;
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: AI uses actual campaign command legality', () => {
  it.each(['absent', 'dead', 'hostile'] as const)(
    'does not fortify with an %s engineer and leaves decision input unchanged',
    (engineer) => {
      const state = legacyGame();
      fillHome(state);
      if (engineer !== 'absent') {
        const u = makeUnit(state, 'A', 'ww2_engineer');
        if (engineer === 'dead') u.hp = 0;
        const holder =
          engineer === 'hostile'
            ? state.armies.find((a) => a.team === 'B' && a.kind === 'commander')!
            : garrisonOf(state, 'A')!;
        holder.units.push(u);
      }
      expect(fortify(structuredClone(state), state.hq.A).ok).toBe(false);
      const before = structuredClone(state);
      const action = strategicAiStep(state);
      expect(action.type).not.toBe('fortify');
      expect(state).toEqual(before);
      expect(apply(state, action).error).toBeNull();
    },
  );

  it('can fortify with a living local engineer and honors the game engineer override', () => {
    const state = legacyGame();
    fillHome(state);
    garrisonOf(state, 'A')!.units[0] = makeUnit(state, 'A', 'ww2_engineer');
    const action = strategicAiStep(state);
    expect(action.type).toBe('fortify');
    expect(apply(state, action).error).toBeNull();
    state.settings.rules = { units: { ww2_engineer: { engineer: false } } };
    expect(strategicAiStep(state).type).not.toBe('fortify');
  });

  it.each([
    { effects: { throughput: 1 }, reason: 'throughput is exhausted', recruits: 2 },
    {
      effects: { throughput: 20, reinforcement: 1 },
      reason: 'reinforcement allowance is exhausted',
      recruits: 1,
    },
  ])('does not emit illegal recruitment after $reason', ({ effects, reason, recruits }) => {
    let state = game(effects);
    for (let i = 0; i < recruits; i++) {
      const action = strategicAiStep(state);
      expect(action.type).toBe('recruit');
      const result = apply(state, action);
      expect(result.error).toBeNull();
      state = result.state;
    }
    expect(recruit(structuredClone(state), 'ww2_rifle_infantry')).toMatchObject({
      ok: false,
      error: expect.stringContaining(reason),
    });
    const before = structuredClone(state);
    const action = strategicAiStep(state);
    expect(action.type).not.toBe('recruit');
    expect(state).toEqual(before);
    expect(apply(state, action).error).toBeNull();
  });

  it('recruits into a legal non-HQ node when the HQ has no housing left', () => {
    const state = game();
    const nodeId = claimCity(state);
    state.turn += 2;
    beginCampaignOwnerTurn(state);
    resumeCampaignTurnStart(state);
    state.cp.A = 100;
    fillHome(state);
    refreshCampaignNodeSnapshot(state);
    const action = strategicAiStep(state);
    expect(action).toMatchObject({ type: 'recruit', nodeId });
    const result = apply(state, action);
    expect(result.error).toBeNull();
    expect(result.state.armies.find((a) => a.nodeId === nodeId)!.units).toHaveLength(1);
  });

  it('does not try to deploy into a newly captured node in the capture owner-cycle', () => {
    const state = game();
    fillHome(state);
    const nodeId = claimCity(state, 'B');
    const node = state.infrastructure!.capture.nodes.find((n) => n.id === nodeId)!;
    const commander = state.armies.find((a) => a.team === 'A' && a.kind === 'commander')!;
    const world = worldOf(state).world;
    setHolderPos(world, commander, node.centerSubHex);
    refreshCampaignNodeSnapshot(state);
    expect(
      prepareCampaignCapture(state, world, {
        requestId: 'ai-capture',
        expectedVersion: state.infrastructure!.capture.version,
        event: { kind: 'strategic-movement', movementReceiptId: 'move-ai-capture' },
      }).ok,
    ).toBe(true);
    const batchId = state.infrastructure!.capture.pending!.request.requestId;
    expect(
      chooseCampaignCapture(state, {
        requestId: 'ai-choose',
        expectedVersion: state.infrastructure!.capture.version,
        batchId,
        nodeId,
        outcome: 'capture',
      }).ok,
    ).toBe(true);
    expect(
      commitCampaignCapture(state, {
        requestId: 'ai-commit',
        expectedVersion: state.infrastructure!.capture.version,
        batchId,
      }).ok,
    ).toBe(true);
    expect(recruit(structuredClone(state), 'ww2_rifle_infantry', nodeId)).toMatchObject({
      ok: false,
      error: expect.stringContaining('cannot deploy troops until its next owner turn'),
    });
    const action = strategicAiStep(state);
    expect(action.type).not.toBe('recruit');
    expect(apply(state, action).error).toBeNull();
  });

  it('upgrades then builds through fresh legal node requests and stops at the node work cap', () => {
    let state = game();
    for (const army of state.armies)
      army.units = army.units.filter((u) => !unitType(u.typeId).engineer);
    fillHome(state);
    garrisonOf(state, 'A')!.units[0] = makeUnit(state, 'A', 'ww2_engineer');
    refreshCampaignNodeSnapshot(state);
    const before = structuredClone(state);
    const first = strategicAiStep(state);
    expect(state).toEqual(before);
    expect(first).toMatchObject({ type: 'nodeWork', request: { kind: 'upgrade' } });
    if (first.type !== 'nodeWork') throw new Error('Expected quoted node work');
    expect(campaignNodeActionChoices(state, first.request.nodeId)).toContainEqual(
      expect.objectContaining({ legal: true, request: first.request }),
    );
    let result = apply(state, first);
    expect(result.error).toBeNull();
    state = result.state;
    const second = strategicAiStep(state);
    expect(second).toMatchObject({ type: 'nodeWork', request: { kind: 'build' } });
    if (second.type !== 'nodeWork') throw new Error('Expected second node operation');
    expect(second.request.requestId).not.toBe(first.request.requestId);
    result = apply(state, second);
    expect(result.error).toBeNull();
    state = result.state;
    expect(strategicAiStep(state).type).not.toBe('nodeWork');
  });

  it('activates a frontier site through the same quoted choices as the player', () => {
    const state = game({ throughput: 0 });
    const site = state.infrastructure!.sites.find(
      (s) => !s.homeTeam && !state.armies.some((a) => a.at === s.mainHex && a.team === 'B'),
    )!;
    const commander = state.armies.find((a) => a.team === 'A' && a.kind === 'commander')!;
    setHolderPos(worldOf(state).world, commander, site.annexSubHexes[0]!);
    refreshCampaignNodeSnapshot(state);
    const action = strategicAiStep(state);
    expect(action).toMatchObject({
      type: 'nodeWork',
      request: { kind: 'activate', nodeId: site.nodeId },
    });
    expect(apply(state, action).error).toBeNull();
  });

  it(
    'emits commands that apply without a fallback through a configured campaign opening',
    { timeout: 60000 },
    () => {
      let state = game();
      state.settings.controllers = { A: 'ai', B: 'ai' };
      const actionTypes = new Set<string>();
      for (let step = 0; step < 40 && isAiTurn(state); step++) {
        const action = aiStep(state);
        actionTypes.add(action.type);
        const result = apply(state, action);
        expect(result.error, `step ${step}: ${JSON.stringify(action)}`).toBeNull();
        state = result.state;
      }
      expect(actionTypes.has('recruit')).toBe(true);
      expect(actionTypes.has('nodeWork')).toBe(true);
    },
  );
});

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: AI respects stationed garrison orders', () => {
  it.each([false, true])(
    'uses legal on-cell Raze Tile without a shot (stationed=%s)',
    (stationed) =>
      flat(() => {
        const state = game();
        const nodeId = claimCity(state, 'B');
        const foundation = state.infrastructure!;
        const site = foundation.sites.find((s) => s.nodeId === nodeId)!;
        const buildingId = 'ai-enemy-annex';
        const subHex = site.annexSubHexes[0]!;
        state.infrastructure = {
          ...foundation,
          capture: {
            ...foundation.capture,
            nodes: foundation.capture.nodes.map((node) =>
              node.id === nodeId
                ? {
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
                          exclusiveChoices: [],
                          unlocks: [],
                          equipmentIds: [],
                        },
                      },
                    ],
                  }
                : node,
            ),
          },
        };
        const world = worldOf(state).world;
        const actor = state.armies.find((a) => a.team === 'A' && a.kind === 'commander')!.units[0]!;
        const enemy = state.armies.find((a) => a.team === 'B' && a.kind === 'commander')!.units[0]!;
        const far = [...world.subByKey.values()].sort(
          (a, b) =>
            hexDistance(b.hex, world.subByKey.get(subHex)!.hex) -
            hexDistance(a.hex, world.subByKey.get(subHex)!.hex),
        )[0]!.key;
        const guard = {
          ...mkUnit(actor.id, actor.typeId, 'A', subHex),
          ...(stationed ? { stationed: true, mp: 0 } : {}),
        };
        state.battle = flatBattle([guard, mkUnit(enemy.id, enemy.typeId, 'B', far)], {
          objective: {
            kind: 'capture_point',
            captureKey: far,
            captureRadius: 0,
            extractionAtOrigin: true,
          },
        }).battle;
        state.phase = 'battle';
        expect(campaignRazeTileOptions(state, actor.id)).toContainEqual(
          expect.objectContaining({ eligible: true, buildingId, actionCost: 1, cpCost: 0 }),
        );
        const before = structuredClone(state);
        const action = tacticalAiStep(state);
        expect(action).toEqual({ type: 'razeTile', unitId: actor.id, buildingId });
        expect(state).toEqual(before);
        const result = apply(state, action);
        expect(result.error).toBeNull();
        expect(result.state.cp).toEqual(before.cp);
        expect(result.state.battle!.units.find((u) => u.id === actor.id)).toMatchObject({
          pos: subHex,
          acted: true,
          mp: 0,
          ...(stationed ? { stationed: true } : {}),
        });
        expect(result.state.battle!.ruinedInfrastructureBuildingIds).toContain(buildingId);
        const originalWork = before.infrastructure!.capture.work;
        expect(result.state.infrastructure!.capture.work).toMatchObject({
          commandPoints: originalWork.commandPoints,
          nodeSpending: originalWork.nodeSpending,
          engineerSpending: originalWork.engineerSpending,
          receipts: originalWork.receipts,
        });
      }),
  );

  it('does not dig, move or set up a stationed engineer with no legal shot', () =>
    flat(() => {
      const state = legacyGame();
      state.settings.grid = { mainCols: 3, mainRows: 3, subRadius: 2 };
      const guard = { ...mkUnit('guard', 'ww2_engineer', 'B', '0,0'), stationed: true, mp: 0 };
      state.battle = flatBattle([guard, mkUnit('enemy', 'ww2_rifle_infantry', 'A', '5,0')], {
        active: 'B',
      }).battle;
      state.phase = 'battle';
      const action = tacticalAiStep(state);
      expect(action).toEqual({ type: 'endBattleTurn' });
      expect(apply(state, action).error).toBeNull();
    }));

  it('still fires from a stationed tile when the normal attack preview is legal', () =>
    flat(() => {
      const state = legacyGame();
      state.settings.grid = { mainCols: 3, mainRows: 3, subRadius: 2 };
      const guard = {
        ...mkUnit('guard', 'ww2_rifle_infantry', 'B', '0,0'),
        stationed: true,
        mp: 0,
      };
      state.battle = flatBattle([guard, mkUnit('enemy', 'ww2_rifle_infantry', 'A', '2,0')], {
        active: 'B',
      }).battle;
      state.phase = 'battle';
      const action = tacticalAiStep(state);
      expect(action).toEqual({ type: 'attack', unitId: 'guard', cell: '2,0' });
      expect(apply(state, action).error).toBeNull();
    }));

  it('skips warned fort placements without an eligible engineer', () =>
    flat(() => {
      const state = legacyGame();
      state.settings.grid = { mainCols: 3, mainRows: 3, subRadius: 2 };
      state.battle = flatBattle([mkUnit('guard', 'ww2_rifle_infantry', 'B', '0,0')], {
        phase: 'deploy',
        deployTeam: 'B',
        warnedPlacements: 2,
        warnedRange: 3,
      }).battle;
      state.phase = 'battle';
      expect(tacticalAiStep(state)).toEqual({ type: 'finishDeploy' });
    }));

  it('ranks free-shot targets with the existing attack score and keeps selection separate', () =>
    flat(() => {
      const state = game();
      const unit = (id: string, typeId = 'ww2_rifle_infantry'): ArmyUnit => ({
        id,
        typeId,
        label: id,
        hp: unitType(typeId).hp,
      });
      state.armies = [
        {
          id: 'guard-holder',
          kind: 'garrison',
          building: 'temporary',
          team: 'A',
          pos: '0,0',
          at: '0,0',
          movesLeft: 0,
          units: [unit('guard', 'ww2_mortar')],
        },
        {
          id: 'weak',
          kind: 'commander',
          team: 'B',
          pos: '5,0',
          at: worldOf(state).world.subByKey.get('5,0')!.main,
          movesLeft: 5,
          units: [{ ...unit('weak-unit'), hp: 1 }],
        },
        {
          id: 'strong',
          kind: 'commander',
          team: 'B',
          pos: '4,0',
          at: worldOf(state).world.subByKey.get('4,0')!.main,
          movesLeft: 5,
          units: [unit('strong-unit')],
        },
      ];
      // Opening an explicit boundary after the already-completed initial boundary tests ranking only.
      state.turn += 2;
      beginCampaignOwnerTurn(state);
      expect(beginCampaignFreeShots(state, 'strategic-after-income', 'A').ok).toBe(true);
      const prompt = campaignFreeShotPrompt(state);
      expect(prompt).toMatchObject({ ok: true, status: 'choose-target' });
      if (!prompt.ok || prompt.status === 'complete') throw new Error('Expected free-shot prompt');
      const options = campaignGarrisonTargetOptions(state, prompt.shooterId, prompt.trigger);
      const expected = [...options].sort((a, b) => {
        const score = (o: typeof a): number => {
          const target = state.armies.find((army) => army.id === o.targetId)!.units[0]!;
          return (
            o.expectedDamage +
            (o.expectedDamage >= target.hp ? 4 : 0) +
            unitType(target.typeId).cost * 0.15 * (o.pDirect + o.pSplash)
          );
        };
        return score(b) - score(a) || a.targetId.localeCompare(b.targetId);
      })[0]!.targetId;
      const before = structuredClone(state);
      expect(chooseCampaignFreeShotAiTarget(state, prompt)).toBe(expected);
      expect(state).toEqual(before);
      expect(chooseCampaignFreeShotAiTarget(state, { ok: true, status: 'complete' })).toBeNull();
    }));
});
