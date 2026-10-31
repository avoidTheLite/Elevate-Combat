import { describe, expect, it } from 'vitest';
import { buildWorld } from '../grid.ts';
import { hexDistance, hexKey } from '../hex.ts';
import type { Terrain } from '../terrain.ts';
import { generateTerrain } from '../terrain.ts';
import { calculateTerritorialIncome, projectTerritorialControl } from './control.ts';
import { applyReinforcementSpend, reinforcementAllowance } from './reinforcement.ts';
import {
  campaignSupplyConnectors,
  campaignSupplyReinforcementAllowance,
  campaignSupplyReinforcementContext,
  createCampaignSupplyRuntime,
  evaluateCampaignSupply,
  openCampaignSupplyCycle,
  projectSupplyBuildingIncome,
  recordCampaignSupplyDeployment,
  refreshCampaignSupplyOrigins,
  validateCampaignSupplyRuntime,
  type CampaignSupplyEvaluation,
  type CampaignSupplyInput,
  type CampaignSupplyRuntime,
} from './campaignSupply.ts';
import type { SupplyProfile } from './supplyGraph.ts';
import { campaignBuildingData } from './campaignNodes.ts';
import type { CampaignInfrastructure } from './campaignNodes.ts';
import { calculateFoundationIncome } from './attributes.ts';
import { createGame, defaultSettings } from '../strategic.ts';
import { validateGameState } from '../save.ts';
import { campaignSupplyView, syncCampaignClaims } from './campaign.ts';
import { createFoundationPlaytestConfiguration } from './playtestProfile.ts';

const world = buildWorld({ mainCols: 3, mainRows: 3, subRadius: 2 });
const terrain: Terrain = {
  heights: new Int8Array(world.subs.length).fill(1),
  mainHeight: new Map(),
  passes: [],
};
const center = (key: string): string => hexKey(world.mainByKey.get(key)!.center);
/** Synthetic explicit fixture tuning, not a selected production profile. */
const profile: SupplyProfile = {
  terrainCosts: { land: 1, marsh: 2 },
  minimumStepCost: 0.1,
  uphillSurcharge: 1,
  downhillCredit: 0.25,
  maximumClimb: 8,
  maximumDrop: 8,
  roadMultiplier: 0.5,
  legRange: 5,
  distanceFloor: 0.3,
  distanceDecay: 0,
  hostileClaimFactor: 0.5,
};
function fixture(): CampaignSupplyInput {
  return {
    world,
    terrain,
    team: 'A',
    profile,
    nodes: [
      {
        id: 'home',
        subHex: center('0,0'),
        owner: 'A',
        operational: true,
        relayRangeBonus: 0,
        authority: 'home',
      },
      {
        id: 'bridge',
        subHex: center('1,0'),
        owner: 'A',
        operational: true,
        relayRangeBonus: 0,
        authority: null,
      },
      {
        id: 'regional',
        subHex: center('2,0'),
        owner: 'A',
        operational: true,
        relayRangeBonus: 0,
        authority: 'regional',
      },
    ],
    roads: [],
    stationedUnits: [],
    control: projectTerritorialControl({
      mainHexIds: world.mains.map((main) => main.key),
      nodes: world.mains.map((main) => ({ id: main.key, mainHexId: main.key, owner: 'A' })),
      holders: [],
    }),
    benefits: [
      {
        id: 'capacity',
        units: 'units',
        homeConnectedBoost: { operation: 'add', value: 2, cap: null },
        maximum: null,
        applyRouteEfficiency: false,
        isolatedRegionalFactor: 1,
        rounding: 'none',
      },
      {
        id: 'income-factor',
        units: 'factor',
        homeConnectedBoost: { operation: 'add', value: 0.1, cap: null },
        maximum: null,
        applyRouteEfficiency: false,
        isolatedRegionalFactor: 0.5,
        rounding: 'none',
      },
    ],
    hqBenefits: [
      {
        authorityId: 'home',
        contributions: [
          { benefitId: 'capacity', value: 10 },
          { benefitId: 'income-factor', value: 1 },
        ],
      },
      {
        authorityId: 'regional',
        contributions: [
          { benefitId: 'capacity', value: 6 },
          { benefitId: 'income-factor', value: 0.5 },
        ],
      },
    ],
  };
}
function runtime(input: CampaignSupplyInput): CampaignSupplyRuntime {
  return createCampaignSupplyRuntime({
    profile: input.profile,
    roads: input.roads,
    benefits: input.benefits,
    hqBenefits: input.hqBenefits,
  });
}
function withoutBridge(input: CampaignSupplyInput): CampaignSupplyInput {
  return {
    ...input,
    nodes: input.nodes.map((node) => ({
      ...node,
      operational: node.id !== 'bridge' && node.operational,
    })),
  };
}
function spend(
  state: CampaignSupplyRuntime,
  supply: CampaignSupplyEvaluation,
  nodeId: string,
  units: number,
  requestId: string,
): CampaignSupplyRuntime {
  const context = campaignSupplyReinforcementContext(state, supply, 'A-cycle', 'capacity', nodeId);
  const islandId = supply.nodes[nodeId].islandId;
  const lane = context.networks.find(
    (network) =>
      JSON.parse(network.networkId)[0] === islandId &&
      reinforcementAllowance(state.reinforcement, context, network.networkId).ok,
  )!;
  const result = applyReinforcementSpend(
    state.reinforcement,
    {
      requestId,
      expectedVersion: state.reinforcement.version,
      team: 'A',
      ownerTurnId: 'A-cycle',
      networkId: lane.networkId,
      units,
    },
    context,
  );
  if (!result.ok) throw new Error(result.reason);
  return recordCampaignSupplyDeployment(
    { ...state, reinforcement: result.state },
    requestId,
    nodeId,
  );
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001/002: actual campaign supply projection', () => {
  it('transports additive .1 and .2 building relay effects through the actual campaign projection exactly', () => {
    const base = createFoundationPlaytestConfiguration(7, 3);
    const destinationMain = world.mains.find((cell) => cell.col === 1 && cell.row === 1)!;
    // Isolated seed-specific fixture: four flat land steps then the marsh destination.
    // Every shortest leg costs .3 + .20000000000000004, just above exact .5 reach.
    const map = generateTerrain(world, 719821);
    map.heights.fill(1);
    map.heights[world.subByKey.get(hexKey(destinationMain.center))!.index] = 0;
    for (const main of world.mains)
      map.mainHeight.set(
        main.key,
        main.key === destinationMain.key ? (main.subKeys.length - 1) / main.subKeys.length : 1,
      );
    const state = createGame({
      ...defaultSettings(),
      seed: 719821,
      controllers: { A: 'human', B: 'human' },
      grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
      infrastructure: {
        ...base,
        nodes: { ...base.nodes, homeCenterTier: 2 },
        supply: {
          ...base.supply,
          legRange: 0.2,
          terrainCosts: { land: 0.075, marsh: 0.20000000000000004 },
          minimumStepCost: 0.001,
          uphillSurcharge: 0.01,
          downhillCredit: 0,
        },
        effects: {
          ...base.effects,
          relay: {
            ...base.effects.relay,
            1: { ...base.effects.relay[1]!, relayRangeBonus: 0.1 },
            2: { ...base.effects.relay[2]!, relayRangeBonus: 0.2 },
          },
        },
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
                  ...[1, 2].map((tier, index) => ({
                    id: `relay-${tier}`,
                    ruined: false,
                    data: {
                      definitionId: 'relay',
                      role: 'relay',
                      specialty: 'logistics',
                      tier,
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
            : node.mainHex === destinationMain.key
              ? {
                  ...node,
                  owner: 'A',
                  buildings: node.buildings.map((building) => ({
                    ...building,
                    data: { ...campaignBuildingData(building), active: true },
                  })),
                }
              : node,
        ),
      },
    };
    syncCampaignClaims(state);
    expect(validateGameState(state)).toEqual([]);
    const supply = campaignSupplyView(state, 'A')!;
    const selfRoute = supply.nodes[site.nodeId].routes.find(
      (route) => route.authorityId === site.nodeId,
    )!;
    expect(selfRoute.legs[0].exactRangeBudget).toEqual({ decimal: '0.5' });
    expect(selfRoute.legs[0].rangeBudget).toBe(0.5);
    const destination = f.sites.find((candidate) => candidate.mainHex === destinationMain.key)!;
    expect(supply.nodes[destination.nodeId].connection).toBe('none');
  });
  it('keeps route decay exact through HQ comparison, building multiplication and aggregate income', () => {
    const input = fixture();
    const target = world.subs.find((cell) => hexDistance({ q: 0, r: 0 }, cell.hex) === 9)!;
    const nodes = [input.nodes[0], { ...input.nodes[1], id: 'destination', subHex: target.key }];
    const supply = evaluateCampaignSupply({
      ...input,
      nodes,
      profile: { ...profile, legRange: 9, distanceDecay: 0.06 },
      benefits: input.benefits.map((benefit) => ({
        ...benefit,
        applyRouteEfficiency: benefit.id === 'income-factor',
      })),
      hqBenefits: [input.hqBenefits[0]],
    });
    expect(supply.nodes.destination.activeRoute!.exactWeightedCost.decimal).toBe('9');
    expect(supply.nodes.destination.activeRoute!.exactEffectiveEfficiency.decimal).toBe('0.46');
    expect(supply.benefitSelections.destination['income-factor'].exactValue.decimal).toBe('0.46');
    const contributions = projectSupplyBuildingIncome(JSON.parse(JSON.stringify(supply)), [
      {
        sourceId: 'building',
        nodeId: 'destination',
        value: 100,
        active: true,
        eligible: true,
        reach: 'network',
        benefitId: 'income-factor',
      },
    ]);
    expect(calculateFoundationIncome({ baseGrant: 3, contributions }).cp).toBe(49);
    const fraction = projectSupplyBuildingIncome(supply, [
      {
        sourceId: 'fraction',
        nodeId: 'home',
        value: { decimal: '0.99999999999999996' },
        active: true,
        eligible: true,
        reach: 'network',
        benefitId: 'income-factor',
      },
    ]);
    const payment = calculateFoundationIncome({
      baseGrant: 0,
      contributions: JSON.parse(JSON.stringify(fraction)),
    });
    expect(payment.cp).toBe(0);
    expect(payment.exactTotal.decimal).toBe('0.99999999999999996');
  });
  it('routes on the real shared lattice through operational node links', () => {
    const input = fixture();
    const supply = evaluateCampaignSupply(input);
    expect(supply.nodes.regional.homeConnected).toBe(true);
    const homeRoute = supply.nodes.regional.routes.find((route) => route.authorityId === 'home')!;
    expect(homeRoute.weightedCost).toBe(10);
    expect(homeRoute.legs).toHaveLength(2);
    expect(homeRoute.path.every((key) => world.subByKey.has(key))).toBe(true);
    expect(supply.islands).toHaveLength(1);
    const split = evaluateCampaignSupply(withoutBridge(input));
    expect(split.nodes.regional.homeConnected).toBe(false);
    expect(split.nodes.regional.connection).toBe('regional');
    expect(split.islands).toHaveLength(2);
  });

  it('selects distinct best HQs per benefit and removes regional boost on a cut', () => {
    const input = fixture();
    const changed = {
      ...input,
      hqBenefits: input.hqBenefits.map((hq) =>
        hq.authorityId === 'regional'
          ? {
              ...hq,
              contributions: [
                { benefitId: 'capacity', value: 12 },
                { benefitId: 'income-factor', value: 0.5 },
              ],
            }
          : hq,
      ),
    };
    const connected = evaluateCampaignSupply(changed);
    expect(connected.benefitSelections.bridge.capacity).toMatchObject({
      providerId: 'regional',
      value: 14,
      homeConnected: true,
    });
    expect(connected.benefitSelections.bridge['income-factor']).toMatchObject({
      providerId: 'home',
      value: 1,
    });
    const cut = evaluateCampaignSupply(withoutBridge(changed));
    expect(cut.benefitSelections.regional.capacity).toMatchObject({
      providerId: 'regional',
      value: 12,
      homeConnected: false,
    });
    expect(cut.benefitSelections.regional['income-factor'].value).toBe(0.25);
  });

  it('gates network building income, preserves local Base and pays raw territory independently', () => {
    const input = fixture();
    const disconnected = evaluateCampaignSupply({
      ...withoutBridge(input),
      nodes: input.nodes.map((node) => ({
        ...node,
        operational: node.id !== 'bridge',
        authority: node.id === 'home' ? 'home' : null,
      })),
      hqBenefits: [input.hqBenefits[0]],
    });
    expect(disconnected.nodes.regional.connection).toBe('none');
    expect(disconnected.benefitSelections.regional.capacity).toMatchObject({
      providerId: null,
      value: 0,
    });
    const contributions = projectSupplyBuildingIncome(disconnected, [
      {
        sourceId: 'network',
        nodeId: 'regional',
        value: 20,
        active: true,
        eligible: true,
        reach: 'network',
        benefitId: 'income-factor',
      },
      {
        sourceId: 'base',
        nodeId: 'regional',
        value: 0.6,
        active: true,
        eligible: true,
        reach: 'base',
        benefitId: null,
      },
    ]);
    expect(contributions[0].eligible).toBe(false);
    expect(contributions[1].value).toEqual({ decimal: '0.6' });
    const payment = calculateTerritorialIncome(input.control, 'A', contributions);
    expect(payment.cp).toBe(3 + world.mains.length);
    expect(payment.exactTotal.decimal).toBe('12.6');
  });

  it('uses actual destination-marsh elevation costs and ignores dead/own stationed blockers', () => {
    const input = fixture();
    const heights = new Int8Array(terrain.heights);
    heights[world.subByKey.get('1,0')!.index] = 0;
    const local = {
      ...input,
      terrain: { ...terrain, heights },
      nodes: [input.nodes[0], { ...input.nodes[1], subHex: '1,0' }],
      hqBenefits: [input.hqBenefits[0]],
    };
    expect(evaluateCampaignSupply(local).nodes.bridge.activeRoute!.weightedCost).toBe(1.75);
    const benign = evaluateCampaignSupply({
      ...local,
      stationedUnits: [
        { unitId: 'dead', team: 'B', subHex: '1,0', hp: 0 },
        { unitId: 'own', team: 'A', subHex: '1,0', hp: 1 },
      ],
    });
    expect(benign.blockedCells).toEqual([]);
    const blocked = evaluateCampaignSupply({
      ...local,
      stationedUnits: [{ unitId: 'guard', team: 'B', subHex: '1,0', hp: 1 }],
    });
    expect(blocked.nodes.bridge.activeRoute).toBeNull();
    expect(blocked.blockedCells).toEqual(['1,0']);
  });

  it('rejects missing tuning, incomplete control and ambiguous building sources', () => {
    const input = fixture();
    const marsh = new Int8Array(terrain.heights);
    marsh[0] = 0;
    expect(() =>
      evaluateCampaignSupply({
        ...input,
        terrain: { ...terrain, heights: marsh },
        profile: { ...profile, terrainCosts: { land: 1 } },
      }),
    ).toThrow('Unknown supply terrain');
    const partial = { ...input.control };
    delete partial['0,0'];
    expect(() => evaluateCampaignSupply({ ...input, control: partial })).toThrow('omits a MainHex');
    const source = {
      sourceId: 'same',
      nodeId: 'home',
      value: 1,
      active: true,
      eligible: true,
      reach: 'base' as const,
      benefitId: null,
    };
    expect(() =>
      projectSupplyBuildingIncome(evaluateCampaignSupply(input), [source, source]),
    ).toThrow('Duplicate');
  });
});

describe('actual node payload supply connector adapter', () => {
  it('recognizes owned operational Home/T2 centers and refuses implicit relay defaults', () => {
    const data = {
      definitionId: 'center',
      role: 'center',
      specialty: 'generic' as const,
      tier: 2 as const,
      placement: 'center' as const,
      subHex: '0,0',
      active: true,
      exclusiveChoices: [],
      unlocks: [],
      equipmentIds: [],
    };
    const infrastructure: Pick<CampaignInfrastructure, 'sites' | 'capture'> = {
      sites: [
        { nodeId: 'city', mainHex: '0,0', centerSubHex: '0,0', annexSubHexes: [], homeTeam: null },
      ],
      capture: {
        version: 0,
        work: {
          version: 0,
          commandPoints: { A: 0, B: 0 },
          nodeSpending: [],
          engineerSpending: [],
          receipts: [],
        },
        nodes: [
          {
            id: 'city',
            mainHex: '0,0',
            centerSubHex: '0,0',
            owner: 'A',
            buildings: [{ id: 'center', ruined: false, data }],
          },
        ],
        pending: null,
        receipts: [],
      },
    };
    expect(campaignSupplyConnectors(infrastructure, { city: 0 })[0]).toMatchObject({
      authority: 'regional',
      operational: true,
    });
    expect(() => campaignSupplyConnectors(infrastructure, {})).toThrow('Explicit node relay');
    const ruined = {
      ...infrastructure,
      capture: {
        ...infrastructure.capture,
        nodes: infrastructure.capture.nodes.map((node) => ({
          ...node,
          buildings: node.buildings.map((building) => ({ ...building, ruined: true })),
        })),
      },
    };
    expect(campaignSupplyConnectors(ruined, { city: 1 })[0]).toMatchObject({
      authority: null,
      operational: false,
    });
  });
});

describe('C1 frozen origins through real supply splits and merges', () => {
  it('bounds a directed destination by eligible HQ capacity while preserving one shared pool', () => {
    const input = fixture();
    const heights = new Int8Array(input.world.subs.length).fill(8);
    heights[input.world.subByKey.get(input.nodes[0].subHex)!.index] = 0;
    const supply = evaluateCampaignSupply({
      ...input,
      terrain: { ...terrain, heights },
      profile: { ...profile, legRange: 100, maximumClimb: 2, maximumDrop: 8 },
      nodes: input.nodes.filter((node) => node.id !== 'bridge'),
    });
    expect(supply.islands).toHaveLength(1);
    expect(supply.nodes.regional.homeConnected).toBe(false);
    expect(supply.benefitSelections.home.capacity.value).toBe(10);
    expect(supply.benefitSelections.regional.capacity.value).toBe(6);
    let state = openCampaignSupplyCycle(runtime(input), supply, 'A-cycle', 'capacity');
    expect(
      campaignSupplyReinforcementAllowance(state, supply, 'A-cycle', 'capacity', 'regional')
        .available,
    ).toBe(6);
    state = spend(state, supply, 'regional', 6, 'directed-regional');
    expect(
      campaignSupplyReinforcementAllowance(state, supply, 'A-cycle', 'capacity', 'regional')
        .available,
    ).toBe(0);
    expect(
      campaignSupplyReinforcementAllowance(state, supply, 'A-cycle', 'capacity', 'home').available,
    ).toBe(4);
  });
  it('shares one original budget across descendants and never replenishes on reconnect', () => {
    const input = fixture();
    const connected = evaluateCampaignSupply(input);
    let state = openCampaignSupplyCycle(runtime(input), connected, 'A-cycle', 'capacity');
    state = spend(state, connected, 'home', 6, 'deploy-1');
    const originalGrant = structuredClone(state.reinforcement.cycles[0].grants);
    const split = evaluateCampaignSupply(withoutBridge(input));
    state = refreshCampaignSupplyOrigins(state, split, 'A-cycle');
    const context = campaignSupplyReinforcementContext(state, split, 'A-cycle', 'capacity');
    expect(context.networks).toHaveLength(2);
    expect(new Set(context.networks.map((network) => network.lineageId)).size).toBe(1);
    for (const lane of context.networks) {
      const allowance = reinforcementAllowance(state.reinforcement, context, lane.networkId);
      expect(allowance).toMatchObject({ ok: true, lineageRemaining: 4, available: 4 });
    }
    state = spend(state, split, 'regional', 4, 'deploy-2');
    const exhausted = campaignSupplyReinforcementContext(state, split, 'A-cycle', 'capacity');
    for (const lane of exhausted.networks)
      expect(reinforcementAllowance(state.reinforcement, exhausted, lane.networkId)).toMatchObject({
        ok: true,
        available: 0,
      });
    state = refreshCampaignSupplyOrigins(state, connected, 'A-cycle');
    expect(state.reinforcement.cycles[0].grants[0].capacity).toBe(originalGrant[0].capacity);
    expect(state.reinforcement.cycles[0].grants[0].spent).toBe(10);
    expect(() => openCampaignSupplyCycle(state, connected, 'A-cycle', 'capacity')).toThrow(
      'already frozen',
    );
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('preserves independent origins on merge while sharing the physical capacity ceiling', () => {
    const input = fixture();
    const split = evaluateCampaignSupply(withoutBridge(input));
    let state = openCampaignSupplyCycle(runtime(input), split, 'A-cycle', 'capacity');
    const opening = structuredClone(state.reinforcement.cycles[0].grants);
    expect(opening.map((grant) => grant.capacity).sort((a, b) => a - b)).toEqual([6, 10]);
    const connected = evaluateCampaignSupply(input);
    state = refreshCampaignSupplyOrigins(state, connected, 'A-cycle');
    const merged = campaignSupplyReinforcementContext(state, connected, 'A-cycle', 'capacity');
    expect(merged.networks).toHaveLength(2);
    expect(merged.networks.map((network) => network.currentRemaining)).toEqual([10, 10]);
    expect(
      campaignSupplyReinforcementAllowance(state, connected, 'A-cycle', 'capacity', 'home')
        .available,
    ).toBe(10);
    expect(state.reinforcement.cycles[0].grants).toEqual(opening);
    state = spend(state, connected, 'home', 6, 'merged-deploy');
    const after = campaignSupplyReinforcementContext(state, connected, 'A-cycle', 'capacity');
    for (const lane of after.networks) expect(lane.currentRemaining).toBe(4);
    expect(
      campaignSupplyReinforcementAllowance(state, connected, 'A-cycle', 'capacity', 'regional')
        .available,
    ).toBe(4);
    expect(state.reinforcement.cycles[0].grants.reduce((sum, grant) => sum + grant.spent, 0)).toBe(
      6,
    );
    const isolated = refreshCampaignSupplyOrigins(state, split, 'A-cycle');
    expect(isolated.reinforcement.cycles[0].grants).toEqual(state.reinforcement.cycles[0].grants);
  });

  it('does not create grants for newly added isolated HQs before the next cycle', () => {
    const input = fixture();
    const initial = evaluateCampaignSupply({
      ...input,
      nodes: input.nodes.map((node) => ({ ...node, operational: node.id === 'home' })),
    });
    let state = openCampaignSupplyCycle(runtime(input), initial, 'A-cycle', 'capacity');
    const later = evaluateCampaignSupply(withoutBridge(input));
    state = refreshCampaignSupplyOrigins(state, later, 'A-cycle');
    const context = campaignSupplyReinforcementContext(state, later, 'A-cycle', 'capacity');
    expect(context.networks).toHaveLength(1);
    expect(
      state.originBindings.find((binding) => binding.nodeId === 'regional')!.lineageIds,
    ).toEqual([]);
    expect(() => recordCampaignSupplyDeployment(state, 'missing', 'regional')).toThrow(
      'successful reinforcement',
    );
  });

  it('requires debit attribution and rejects attributing a debit outside its frozen network', () => {
    const input = fixture();
    const split = evaluateCampaignSupply(withoutBridge(input));
    const state = openCampaignSupplyCycle(runtime(input), split, 'A-cycle', 'capacity');
    const context = campaignSupplyReinforcementContext(state, split, 'A-cycle', 'capacity');
    const homeLane = context.networks.find(
      (network) => JSON.parse(network.networkId)[0] === split.nodes.home.islandId,
    )!;
    const debit = applyReinforcementSpend(
      state.reinforcement,
      {
        requestId: 'debit',
        expectedVersion: state.reinforcement.version,
        team: 'A',
        ownerTurnId: 'A-cycle',
        networkId: homeLane.networkId,
        units: 1,
      },
      context,
    );
    if (!debit.ok) throw new Error(debit.reason);
    const pending = { ...state, reinforcement: debit.state };
    expect(validateCampaignSupplyRuntime(pending)).toMatch(/requires deployment attribution/);
    expect(() => campaignSupplyReinforcementContext(pending, split, 'A-cycle', 'capacity')).toThrow(
      'durable deployment-node',
    );
    expect(() => recordCampaignSupplyDeployment(pending, 'debit', 'regional')).toThrow(
      'not in the debit network',
    );
    const attributed = recordCampaignSupplyDeployment(pending, 'debit', 'home');
    expect(validateCampaignSupplyRuntime(attributed)).toBeNull();
    expect(validateCampaignSupplyRuntime(JSON.parse(JSON.stringify(attributed)))).toBeNull();
    expect(
      validateCampaignSupplyRuntime({ ...attributed, profile: { ...profile, legRange: Infinity } }),
    ).not.toBeNull();
    expect(recordCampaignSupplyDeployment(attributed, 'debit', 'home')).toBe(attributed);
  });
});
