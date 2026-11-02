import { describe, expect, it } from 'vitest';
import { moveCommander } from '../command.ts';
import { createGame, defaultSettings, garrisonOf, setHolderPos, worldOf } from '../strategic.ts';
import type { GameState } from '../types.ts';
import type { CampaignBuildingEffects, CampaignConfiguration } from './campaign.ts';
import {
  beginCampaignOwnerTurn,
  campaignNodeEffects,
  resumeCampaignTurnStart,
} from './campaign.ts';
import {
  campaignBuildingData,
  chooseCampaignCapture,
  commitCampaignCapture,
  prepareCampaignCapture,
  refreshCampaignNodeSnapshot,
} from './campaignNodes.ts';
import { createFoundationPlaytestConfiguration } from './playtestProfile.ts';
import { quoteCampaignRecruitment, recruitCampaignUnit } from './campaignRecruitment.ts';
import { validateCampaignSupplyRuntime } from './campaignSupply.ts';

/** Explicit synthetic configuration values isolate each capacity boundary. */
function game(
  effects: Partial<CampaignBuildingEffects> = {},
  legRange?: number,
  multipliers: Partial<
    Pick<CampaignConfiguration, 'throughputHomeMultiplier' | 'throughputRegionalMultiplier'>
  > = {},
): GameState {
  const base = createFoundationPlaytestConfiguration(7, 3);
  const configuration: CampaignConfiguration = {
    ...base,
    ...multipliers,
    supply: legRange === undefined ? base.supply : { ...base.supply, legRange },
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
  return configuredGame(configuration);
}
function configuredGame(configuration: CampaignConfiguration): GameState {
  const state = createGame({
    ...defaultSettings(),
    seed: 1,
    controllers: { A: 'human', B: 'human' },
    grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
    infrastructure: configuration,
  });
  state.cp.A = 100;
  refreshCampaignNodeSnapshot(state);
  return state;
}
function homeId(state: GameState): string {
  return state.infrastructure!.sites.find((site) => site.homeTeam === 'A')!.nodeId;
}
function neutralId(state: GameState): string {
  return state.infrastructure!.sites.find(
    (site) =>
      site.homeTeam === null &&
      !state.armies.some((army) => army.at === site.mainHex && army.units.length),
  )!.nodeId;
}
function claimCity(state: GameState, owner: 'A' | 'B' = 'A'): string {
  const nodeId = neutralId(state);
  const f = state.infrastructure!;
  state.infrastructure = {
    ...f,
    capture: {
      ...f.capture,
      nodes: f.capture.nodes.map((node) =>
        node.id === nodeId
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
  return nodeId;
}
function newCycle(state: GameState): void {
  state.turn += 2;
  beginCampaignOwnerTurn(state);
  resumeCampaignTurnStart(state);
  state.cp.A = 100;
  refreshCampaignNodeSnapshot(state);
}
function reject(
  state: GameState,
  message: string,
  nodeId?: string,
  typeId = 'ww2_rifle_infantry',
): void {
  const before = structuredClone(state);
  expect(recruitCampaignUnit(state, typeId, nodeId)).toMatchObject({
    ok: false,
    error: expect.stringContaining(message),
  });
  expect(state).toEqual(before);
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: actual recruitment gates and C1 spending', () => {
  it('adds a real HQ unit and deducts existing unit cost plus one conserved deployment', () => {
    const state = game();
    const before = state.cp.A;
    const id = state.nextId;
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry')).toEqual({ ok: true });
    expect(garrisonOf(state, 'A')!.units).toHaveLength(1);
    expect(garrisonOf(state, 'A')!.units[0]).toMatchObject({
      id: `Au${id}`,
      typeId: 'ww2_rifle_infantry',
      hp: expect.any(Number),
    });
    expect(state.cp.A).toBe(before - 3);
    const supply = state.infrastructure!.supply!;
    expect(supply.reinforcement.receipts).toHaveLength(1);
    expect(supply.reinforcement.receipts[0].request.units).toBe(1);
    expect(supply.deployments[0].nodeId).toBe(homeId(state));
    expect(validateCampaignSupplyRuntime(supply)).toBeNull();
    expect(state.nextId).toBe(id + 1);
  });

  it('honors the running game unit cost and HP overrides', () => {
    const state = game();
    state.settings.rules = { units: { ww2_rifle_infantry: { cost: 1, hp: 17 } } };
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry')).toEqual({ ok: true });
    expect(state.cp.A).toBe(99);
    expect(garrisonOf(state, 'A')!.units[0].hp).toBe(17);
  });

  it('enforces throughput by deployment receipts even after troops transfer away', () => {
    const state = game({ throughput: 1 });
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry').ok).toBe(true);
    const garrison = garrisonOf(state, 'A')!;
    const commander = state.armies.find((army) => army.team === 'A' && army.kind === 'commander')!;
    commander.units.push(...garrison.units.splice(0));
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry').ok).toBe(true);
    reject(state, 'throughput is exhausted');
    expect(garrisonOf(state, 'A')!.units).toHaveLength(1);
    expect(state.infrastructure!.supply!.reinforcement.receipts).toHaveLength(2);
  });

  it('preserves twelve HQ housing slots from the explicit review center profile', () => {
    const state = game({ throughput: 20, reinforcement: 20 });
    for (let i = 0; i < 12; i++)
      expect(recruitCampaignUnit(state, 'ww2_rifle_infantry')).toEqual({ ok: true });
    expect(garrisonOf(state, 'A')!.units).toHaveLength(12);
    reject(state, 'housing is full');
  });

  it('does not top up a frozen shared network budget merely because throughput remains', () => {
    const state = game({ throughput: 20, reinforcement: 1 });
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry').ok).toBe(true);
    reject(state, 'reinforcement allowance is exhausted');
    const grant = state.infrastructure!.supply!.reinforcement.cycles.find(
      (cycle) => cycle.ownerTurnId === state.infrastructure!.ownerTurns.A,
    )!.grants[0];
    expect(grant).toMatchObject({ capacity: 1, spent: 1 });
  });

  it('creates a separate owned node garrison from an active recruitment building', () => {
    const state = game();
    const nodeId = claimCity(state);
    newCycle(state);
    const oldHq = garrisonOf(state, 'A')!;
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry', nodeId)).toEqual({ ok: true });
    const garrison = state.armies.find(
      (army) => army.kind === 'garrison' && army.building === 'node' && army.nodeId === nodeId,
    )!;
    const node = state.infrastructure!.capture.nodes.find((candidate) => candidate.id === nodeId)!;
    expect(garrison).toMatchObject({
      team: 'A',
      pos: node.centerSubHex,
      at: node.mainHex,
      movesLeft: 0,
    });
    expect(garrison.units).toHaveLength(1);
    expect(oldHq.units).toHaveLength(0);
  });

  it('uses one-times local throughput under isolated Regional HQ authority', () => {
    const state = game({ throughput: 1 }, 0.1);
    const nodeId = claimCity(state);
    newCycle(state);
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry', nodeId)).toEqual({ ok: true });
    reject(state, 'throughput is exhausted (1/1)', nodeId);
  });

  it('refuses an active T1 recruitment building without an eligible supply authority', () => {
    const state = game({}, 0.1);
    const nodeId = claimCity(state);
    const f = state.infrastructure!;
    state.infrastructure = {
      ...f,
      capture: {
        ...f.capture,
        nodes: f.capture.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                buildings: node.buildings.map((building) => ({
                  ...building,
                  data: { ...campaignBuildingData(building), tier: 1 },
                })),
              }
            : node,
        ),
      },
    };
    reject(state, 'no eligible supply authority', nodeId);
  });

  it('adds active annex housing to active center housing without a hidden HQ base', () => {
    const state = game({ housing: 0, throughput: 20, reinforcement: 20 });
    const f = state.infrastructure!;
    const site = f.sites.find((candidate) => candidate.homeTeam === 'A')!;
    state.infrastructure = {
      ...f,
      capture: {
        ...f.capture,
        nodes: f.capture.nodes.map((node) =>
          node.id === site.nodeId
            ? {
                ...node,
                buildings: [
                  ...node.buildings,
                  {
                    id: 'housing-annex',
                    ruined: false,
                    data: {
                      definitionId: 'barracks',
                      role: 'barracks',
                      specialty: 'military',
                      tier: 1,
                      placement: 'annex',
                      subHex: site.annexSubHexes[0],
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
    for (let i = 0; i < 4; i++)
      expect(recruitCampaignUnit(state, 'ww2_rifle_infantry')).toEqual({ ok: true });
    reject(state, 'housing is full (4/4)');
  });

  it('requires recruitment eligibility independently of housing and throughput', () => {
    const state = game({ recruitment: false, housing: 20, throughput: 20 });
    const nodeId = claimCity(state);
    newCycle(state);
    reject(state, 'no active recruitment building', nodeId);
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry')).toEqual({ ok: true });
  });

  it('rejects unsupported non-HQ mixed occupancy without inheriting another force', () => {
    const state = game();
    const nodeId = claimCity(state);
    newCycle(state);
    const commander = state.armies.find((army) => army.team === 'A' && army.kind === 'commander')!;
    const node = state.infrastructure!.capture.nodes.find((candidate) => candidate.id === nodeId)!;
    setHolderPos(worldOf(state).world, commander, node.centerSubHex);
    reject(state, 'occupied by another force', nodeId);
  });

  it('rejects HQ recruitment after a commander moves onto its empty center garrison', () => {
    const state = game();
    const commander = state.armies.find((army) => army.team === 'A' && army.kind === 'commander')!;
    const hq = garrisonOf(state, 'A')!;
    expect(moveCommander(state, commander.id, hq.pos)).toMatchObject({ ok: true });
    expect(commander.pos).toBe(hq.pos);
    expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry')).toMatchObject({
      allowed: false,
      reason: 'Node center is occupied by another force',
    });
    reject(state, 'occupied by another force');
  });

  it('gates supplied authority and rejects inactive or enemy nodes', () => {
    const state = game();
    const nodeId = claimCity(state);
    newCycle(state);
    const f = state.infrastructure!;
    state.infrastructure = {
      ...f,
      capture: {
        ...f.capture,
        nodes: f.capture.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                buildings: node.buildings.map((building) => ({ ...building, ruined: true })),
              }
            : node,
        ),
      },
    };
    reject(state, 'active node center', nodeId);
    const enemy = state.infrastructure!.sites.find((site) => site.homeTeam === 'B')!.nodeId;
    reject(state, 'do not control', enemy);
  });

  it('rejects acquired-node deployment in the capture owner-cycle using a real capture receipt', () => {
    const state = game();
    const nodeId = claimCity(state, 'B');
    const node = state.infrastructure!.capture.nodes.find((candidate) => candidate.id === nodeId)!;
    const commander = state.armies.find((army) => army.team === 'A' && army.kind === 'commander')!;
    const world = worldOf(state).world;
    setHolderPos(world, commander, node.centerSubHex);
    refreshCampaignNodeSnapshot(state);
    expect(
      prepareCampaignCapture(state, world, {
        requestId: 'movement-capture',
        expectedVersion: state.infrastructure!.capture.version,
        event: { kind: 'strategic-movement', movementReceiptId: 'movement-1' },
      }),
    ).toMatchObject({ ok: true });
    const pending = state.infrastructure!.capture.pending!;
    expect(pending).not.toBeNull();
    reject(state, 'Resolve pending capture', nodeId);
    expect(
      chooseCampaignCapture(state, {
        requestId: 'choose-capture',
        expectedVersion: state.infrastructure!.capture.version,
        batchId: pending.request.requestId,
        nodeId,
        outcome: 'capture',
      }),
    ).toMatchObject({ ok: true });
    expect(
      commitCampaignCapture(state, {
        requestId: 'commit-capture',
        expectedVersion: state.infrastructure!.capture.version,
        batchId: pending.request.requestId,
      }),
    ).toMatchObject({ ok: true });
    reject(state, 'cannot deploy troops until its next owner turn', nodeId);
    const away = world.mainByKey
      .get(state.hq.A)!
      .subKeys.find((key) => !state.armies.some((army) => army.pos === key))!;
    setHolderPos(world, commander, away);
    newCycle(state);
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry', nodeId)).toEqual({ ok: true });
  });

  it('rejects wrong era, missing CP, pending turn resolution and a closed phase without mutation', () => {
    const state = game();
    reject(state, 'Wrong era', undefined, 'med_infantry');
    state.cp.A = 0;
    reject(state, 'Need 3 CP');
    state.cp.A = 100;
    state.phase = 'battle-pending';
    reject(state, 'Not in strategic phase');
    state.phase = 'strategic';
    state.infrastructure = {
      ...state.infrastructure!,
      clock: {
        ...state.infrastructure!.clock!,
        pendingTurnStart: state.infrastructure!.ownerTurns.A,
      },
    };
    reject(state, 'Turn-start resolution');
  });

  it('uses declared active building effects instead of inventing housing or throughput defaults', () => {
    const state = game({ housing: 0, throughput: 0 });
    expect(campaignNodeEffects(state, homeId(state))[0].effects.housing).toBe(0);
    reject(state, 'housing is full');
  });

  it('rejects a reused request identity even after the old unit no longer exists', () => {
    const state = game();
    const nextId = state.nextId;
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry')).toEqual({ ok: true });
    garrisonOf(state, 'A')!.units = [];
    state.nextId = nextId;
    reject(state, 'identity has already been spent');
  });
});

describe('authoritative recruitment quotes', () => {
  it('uses exact additive/multiplicative throughput so .58 × 50 permits all 29 recruits', () => {
    const state = game({ housing: 100, throughput: 0.58, reinforcement: 100 }, undefined, {
      throughputHomeMultiplier: 50,
    });
    state.cp.A = 1000;
    refreshCampaignNodeSnapshot(state);
    expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry')).toMatchObject({
      allowed: true,
      throughput: 29,
      localRemaining: 29,
    });
    for (let i = 0; i < 29; i++) {
      const before = structuredClone(state);
      expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry')).toMatchObject({
        allowed: true,
        throughput: 29,
        throughputUsed: i,
        localRemaining: 29 - i,
      });
      expect(state).toEqual(before);
      expect(recruitCampaignUnit(state, 'ww2_rifle_infantry')).toEqual({ ok: true });
    }
    expect(garrisonOf(state, 'A')!.units).toHaveLength(29);
    expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry')).toMatchObject({
      allowed: false,
      throughput: 29,
      throughputUsed: 29,
      localRemaining: 0,
    });
    reject(state, 'throughput is exhausted (29/29)');
  });

  it('sums fractional center and annex housing before one whole-unit floor', () => {
    const base = createFoundationPlaytestConfiguration(7, 3);
    const state = configuredGame({
      ...base,
      effects: {
        ...base.effects,
        generic: {
          ...base.effects.generic,
          1: { ...base.effects.generic[1]!, housing: 0.58, throughput: 20 },
        },
        workshop: { ...base.effects.workshop, 1: { ...base.effects.workshop[1]!, housing: 0.29 } },
        barracks: { ...base.effects.barracks, 1: { ...base.effects.barracks[1]!, housing: 0.13 } },
      },
    });
    const f = state.infrastructure!;
    const site = f.sites.find((candidate) => candidate.homeTeam === 'A')!;
    state.infrastructure = {
      ...f,
      capture: {
        ...f.capture,
        nodes: f.capture.nodes.map((node) =>
          node.id === site.nodeId
            ? {
                ...node,
                buildings: [
                  ...node.buildings,
                  ...['workshop', 'barracks'].map((definitionId, index) => ({
                    id: `fractional-${definitionId}`,
                    ruined: false,
                    data: {
                      definitionId,
                      role: definitionId,
                      specialty: definitionId === 'workshop' ? 'industrial' : 'military',
                      tier: 1,
                      placement: 'annex',
                      subHex: site.annexSubHexes[index],
                      active: true,
                      exclusiveChoices: [],
                      unlocks: [],
                      equipmentIds: [],
                    },
                  })),
                ],
              }
            : node,
        ),
      },
    };
    const before = structuredClone(state);
    expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry')).toMatchObject({
      allowed: true,
      housing: 1,
      occupied: 0,
    });
    expect(state).toEqual(before);
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry')).toEqual({ ok: true });
    expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry')).toMatchObject({
      allowed: false,
      housing: 1,
      occupied: 1,
    });
    reject(state, 'housing is full (1/1)');
  });

  it('reports actual local/shared capacity without issuing units, IDs, receipts or CP', () => {
    const state = game();
    const before = structuredClone(state);
    const quote = quoteCampaignRecruitment(state, 'ww2_rifle_infantry');
    expect(quote).toMatchObject({
      allowed: true,
      reason: null,
      nodeId: homeId(state),
      targetHolderId: garrisonOf(state, 'A')!.id,
      cost: 3,
      housing: 12,
      occupied: 0,
      throughput: 2,
      throughputUsed: 0,
      localRemaining: 2,
      sharedRemaining: 10,
    });
    expect(state).toEqual(before);
    expect(recruitCampaignUnit(state, 'ww2_rifle_infantry')).toEqual({ ok: true });
    expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry')).toMatchObject({
      occupied: 1,
      throughputUsed: 1,
      localRemaining: 1,
      sharedRemaining: 9,
    });
  });

  it('returns the exact mutator refusal and does not guess missing node or unit data', () => {
    const state = game();
    state.cp.A = 0;
    const before = structuredClone(state);
    const actual = recruitCampaignUnit(structuredClone(state), 'ww2_rifle_infantry');
    expect(actual).toEqual({ ok: false, error: 'Need 3 CP' });
    expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry')).toMatchObject({
      allowed: false,
      reason: 'Need 3 CP',
      cost: 3,
    });
    expect(quoteCampaignRecruitment(state, 'missing-unit')).toMatchObject({
      allowed: false,
      cost: null,
    });
    expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry', 'missing-node')).toMatchObject({
      allowed: false,
      reason: 'Unknown recruitment node',
      nodeId: null,
      housing: null,
    });
    expect(state).toEqual(before);
  });
});
