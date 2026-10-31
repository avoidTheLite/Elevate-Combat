// GAMES-ELEVATE-CAMPAIGN-UC-001 / UC-002: canonical detail acceptance with positive controls.
import { describe, expect, it } from 'vitest';
import { apply, type GameAction } from '../actions.ts';
import { createGame, defaultSettings, makeUnit, setHolderPos, worldOf } from '../strategic.ts';
import { hexDistance, hexKey, parseKey } from '../hex.ts';
import { evaluateCampaignSupply } from './campaignSupply.ts';
import { projectTerritorialControl } from './control.ts';
import { deserializeSave, serializeSave, validateGameState } from '../save.ts';
import type { Army, GameState } from '../types.ts';
import { aiStep } from '../runner.ts';
import {
  campaignIncome,
  campaignSupplyView,
  refreshCampaignNetworks,
  syncCampaignClaims,
} from './campaign.ts';
import type { CampaignConfiguration } from './campaign.ts';
import { createFoundationPlaytestConfiguration } from './playtestProfile.ts';
import {
  campaignBuildingData,
  campaignNodeViews,
  constructCampaignNodeRequest,
  refreshCampaignNodeSnapshot,
} from './campaignNodes.ts';
import type { CampaignNodeActionInput, CampaignNodeSite } from './campaignNodes.ts';
import {
  beginFoundationCapture,
  chooseFoundationCapture,
  commitFoundationCapture,
  validateFoundationCaptureState,
} from './capture.ts';
import type {
  FoundationCaptureNode,
  FoundationCaptureState,
  FoundationCaptureResult,
} from './capture.ts';
import { evaluateSupplyGraph } from './supplyGraph.ts';

function configuration(): CampaignConfiguration {
  const c = createFoundationPlaytestConfiguration(7, 3);
  const workshop = c.nodes.definitions.find((d) => d.id === 'workshop')!;
  return {
    ...c,
    id: 'canonical-acceptance-fixture',
    nodes: {
      ...c.nodes,
      definitions: [
        ...c.nodes.definitions.map((d) =>
          d.id === 'tower'
            ? {
                ...d,
                exclusiveUpgrades: [
                  { id: 'lookout', cpCost: 2, engineerRequired: false },
                  { id: 'comm-hub', cpCost: 2, engineerRequired: false },
                ],
              }
            : d,
        ),
        { ...workshop, id: 'forge', name: 'Forge', role: 'forge' },
        { ...workshop, id: 'hospital', name: 'Hospital', role: 'hospital', specialty: 'medical' },
      ],
    },
    effects: { ...c.effects, forge: c.effects.workshop, hospital: c.effects.workshop },
  };
}
function game(profile: CampaignConfiguration = configuration()): GameState {
  const g = createGame({
    ...defaultSettings(),
    seed: 1,
    fog: false,
    commanderTrainingCp: 11,
    controllers: { A: 'human', B: 'human' },
    grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
    infrastructure: profile,
  });
  g.cp = { A: 100, B: 100 };
  refreshCampaignNodeSnapshot(g);
  return g;
}
const commander = (g: GameState): Army =>
  g.armies.find((h) => h.team === 'A' && h.kind === 'commander')!;
const home = (g: GameState): CampaignNodeSite =>
  g.infrastructure!.sites.find((s) => s.homeTeam === 'A')!;
const node = (g: GameState, id: string): FoundationCaptureNode =>
  g.infrastructure!.capture.nodes.find((n) => n.id === id)!;
function updateNode(
  g: GameState,
  id: string,
  change: (n: FoundationCaptureNode) => FoundationCaptureNode,
): void {
  const f = g.infrastructure!;
  g.infrastructure = {
    ...f,
    capture: { ...f.capture, nodes: f.capture.nodes.map((n) => (n.id === id ? change(n) : n)) },
  };
  refreshCampaignNodeSnapshot(g);
  refreshCampaignNetworks(g);
}
function seedCenter(g: GameState, specialty: 'generic' | 'industrial', tier: 1 | 2 | 3): void {
  updateNode(g, home(g).nodeId, (n) => ({
    ...n,
    buildings: n.buildings.map((b) =>
      campaignBuildingData(b).placement === 'center'
        ? {
            ...b,
            data: {
              ...campaignBuildingData(b),
              definitionId: specialty,
              role: specialty,
              specialty,
              tier,
            },
          }
        : b,
    ),
  }));
}

function step(g: GameState, action: GameAction): GameState {
  const next = apply(g, action);
  expect(next.error, `${action.type}: ${next.error}`).toBeNull();
  expect(validateGameState(next.state)).toEqual([]);
  return next.state;
}
function work(g: GameState, input: CampaignNodeActionInput): GameState {
  return step(g, { type: 'nodeWork', request: constructCampaignNodeRequest(g, input) });
}
function refusal(g: GameState, input: CampaignNodeActionInput, reason: string): void {
  const before = structuredClone(g);
  const next = apply(g, { type: 'nodeWork', request: constructCampaignNodeRequest(g, input) });
  expect(next.error).toContain(reason);
  expect(g).toEqual(before);
  expect(next.state).toEqual(before);
}
function resume(g: GameState): GameState {
  const result = deserializeSave(
    serializeSave(g, 'Canonical acceptance', '2026-10-31T12:00:00.000Z'),
  );
  if (!result.ok) throw new Error(result.error);
  expect(result.save.state).toEqual(g);
  return result.save.state;
}
function build(
  g: GameState,
  definitionId: string,
  tier: 1 | 2 | 3,
  slot = 0,
): CampaignNodeActionInput {
  return {
    kind: 'build',
    nodeId: home(g).nodeId,
    definitionId,
    tier,
    subHex: home(g).annexSubHexes[slot],
    engineerUnitId: null,
  };
}

/** Scripted opening ownership/positions; every later income, deployment, activation and commit is a real action. */
function disconnectedNetwork(
  bridgeActive = false,
  regional = true,
): { state: GameState; bridge: CampaignNodeSite; remote: CampaignNodeSite } {
  const c = configuration();
  const state = game({
    ...c,
    supply: {
      ...c.supply,
      terrainCosts: { land: 1, marsh: 1 },
      uphillSurcharge: 0.01,
      downhillCredit: 0,
      maximumClimb: 8,
      maximumDrop: 8,
      legRange: 6,
      distanceDecay: 0,
    },
  });
  const f = state.infrastructure!;
  const source = home(state);
  const distance = (a: CampaignNodeSite, b: CampaignNodeSite): number =>
    hexDistance(parseKey(a.centerSubHex), parseKey(b.centerSubHex));
  const pair = f.sites.flatMap((bridge) =>
    bridge.homeTeam === null && distance(source, bridge) === 5
      ? f.sites
          .filter(
            (remote) =>
              remote.homeTeam === null &&
              remote.nodeId !== bridge.nodeId &&
              distance(source, remote) > 6 &&
              distance(bridge, remote) === 5,
          )
          .map((remote) => ({ bridge, remote }))
      : [],
  )[0];
  expect(pair).toBeDefined();
  const { bridge, remote } = pair;
  updateNode(state, remote.nodeId, (n) => ({
    ...n,
    owner: 'A',
    buildings: n.buildings.map((b) => ({
      ...b,
      data: { ...campaignBuildingData(b), active: true, tier: regional ? 2 : 1 },
    })),
  }));
  if (bridgeActive)
    updateNode(state, bridge.nodeId, (n) => ({
      ...n,
      owner: 'A',
      buildings: n.buildings.map((b) => ({
        ...b,
        data: { ...campaignBuildingData(b), active: true },
      })),
    }));
  const position = bridge.annexSubHexes.find(
    (key) => !state.armies.some((army) => army.pos === key),
  )!;
  setHolderPos(worldOf(state).world, commander(state), position);
  syncCampaignClaims(state);
  refreshCampaignNodeSnapshot(state);
  refreshCampaignNetworks(state);
  return { state, bridge, remote };
}

function captureSuccess(result: FoundationCaptureResult): FoundationCaptureState {
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  expect(validateFoundationCaptureState(result.state)).toBeNull();
  return result.state;
}
function threeChoices(): FoundationCaptureState {
  const source: FoundationCaptureState = {
    version: 0,
    work: {
      version: 0,
      commandPoints: { A: 40, B: 17 },
      nodeSpending: [],
      engineerSpending: [],
      receipts: [],
    },
    nodes: ['one', 'two', 'three'].map((id) => ({
      id,
      mainHex: `main-${id}`,
      centerSubHex: `center-${id}`,
      owner: 'B',
      buildings: [
        {
          id: `${id}:center`,
          ruined: false,
          data: { upgrades: ['saved-upgrade'], equipment: ['saved-item'] },
        },
        { id: `${id}:annex`, ruined: true, data: { upgrades: ['damaged-upgrade'], equipment: [] } },
      ],
    })),
    pending: null,
    receipts: [],
  };
  return captureSuccess(
    beginFoundationCapture(
      source,
      { requestId: 'triple', expectedVersion: 0 },
      {
        snapshotVersion: 0,
        ownerTurn: { team: 'A', id: 'A-turn' },
        event: { kind: 'turn-start-after-income', incomeReceiptId: 'paid-income' },
        costs: { capture: 7, raze: 3 },
        candidates: source.nodes.map((n) => ({
          nodeId: n.id,
          liveGarrisonUnitIds: [],
          liveHostileMainHexUnitIds: [],
          liveCenterOccupants: [{ unitId: `unit-${n.id}`, team: 'A' }],
          commanders: [
            {
              id: `commander-${n.id}`,
              team: 'A',
              mainHex: n.mainHex,
              subHex: n.centerSubHex,
              living: true,
            },
          ],
        })),
      },
    ),
  );
}
function selection(
  g: FoundationCaptureState,
  nodeId: string,
  outcome: 'capture' | 'raze' | 'none',
): FoundationCaptureState {
  return captureSuccess(
    chooseFoundationCapture(g, {
      requestId: `choose-${nodeId}`,
      expectedVersion: g.version,
      batchId: 'triple',
      nodeId,
      outcome,
    }),
  );
}
function commitTriple(
  g: FoundationCaptureState,
  expectedVersion = g.version,
): FoundationCaptureResult {
  return commitFoundationCapture(
    g,
    { requestId: 'commit-triple', expectedVersion, batchId: 'triple' },
    { snapshotVersion: g.version, ownerTurn: { team: 'A', id: 'A-turn' } },
  );
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: canonical configured work acceptance', () => {
  it('TS-020: Industrial T1 funds Forge T2 but refuses T3 before spending, while Industrial T2 permits T3', () => {
    const low = game();
    seedCenter(low, 'industrial', 1);
    expect(
      low.infrastructure!.capture.work.nodeSpending.find((s) => s.nodeId === home(low).nodeId)
        ?.operationCount ?? 0,
    ).toBe(0);
    refusal(low, build(low, 'forge', 3), 'ineligible');
    const built = work(low, build(low, 'forge', 2));
    expect(built.cp.A).toBe(low.cp.A - 6);
    expect(campaignBuildingData(node(built, home(built).nodeId).buildings[1]).tier).toBe(2);
    const high = game();
    seedCenter(high, 'industrial', 2);
    const tier3 = work(high, build(high, 'forge', 3));
    expect(tier3.cp.A).toBe(high.cp.A - 9);
  });

  it('TS-021/031: off-specialty Hospital T2 refuses eligibility with unused work and sufficient CP, while T1 succeeds', () => {
    const g = game();
    seedCenter(g, 'industrial', 2);
    const beforeWork = structuredClone(g.infrastructure!.capture.work);
    refusal(g, build(g, 'hospital', 2), 'ineligible');
    expect(g.infrastructure!.capture.work).toEqual(beforeWork);
    let t1 = work(g, build(g, 'hospital', 1));
    expect(t1.cp.A).toBe(g.cp.A - 3);
    expect(campaignBuildingData(node(t1, home(t1).nodeId).buildings[1]).tier).toBe(1);
    t1 = step(step(t1, { type: 'endTurn' }), { type: 'endTurn' });
    const hospital = node(t1, home(t1).nodeId).buildings.find(
      (b) => campaignBuildingData(b).definitionId === 'hospital',
    )!;
    const engineer = commander(t1).units.find((u) => u.typeId === 'ww2_engineer')!;
    const upgrade: CampaignNodeActionInput = {
      kind: 'upgrade',
      nodeId: home(t1).nodeId,
      buildingId: hospital.id,
      tier: 2,
      engineerUnitId: engineer.id,
    };
    expect(
      campaignNodeViews(t1).find((v) => v.nodeId === home(t1).nodeId)!.work.operationsRemaining,
    ).toBe(2);
    refusal(t1, upgrade, 'ineligible');
    const eligible = structuredClone(t1);
    seedCenter(eligible, 'generic', 3);
    const upgraded = work(eligible, upgrade);
    expect(upgraded.cp.A).toBe(eligible.cp.A - 5);
    expect(
      campaignBuildingData(
        node(upgraded, home(upgraded).nodeId).buildings.find((b) => b.id === hospital.id)!,
      ).tier,
    ).toBe(2);
  });

  it('TS-022: Generic T3 permits specialty T3 through the real construction CP boundary', () => {
    const g = game();
    seedCenter(g, 'generic', 3);
    const next = work(g, build(g, 'hospital', 3));
    expect(next.cp.A).toBe(g.cp.A - 9);
    expect(campaignBuildingData(node(next, home(next).nodeId).buildings[1])).toMatchObject({
      specialty: 'medical',
      tier: 3,
    });
    expect(
      next.infrastructure!.capture.work.nodeSpending.find((s) => s.nodeId === home(next).nodeId),
    ).toMatchObject({ ordinarySpent: true, operationCount: 1 });
  });

  it('TS-023/031: exclusive conflict refuses its option before spending even after a fresh owner turn restores all work', () => {
    let g = game();
    g = work(g, build(g, 'tower', 1));
    const tower = node(g, home(g).nodeId).buildings.find(
      (b) => campaignBuildingData(b).definitionId === 'tower',
    )!;
    g = work(g, {
      kind: 'select-exclusive',
      nodeId: home(g).nodeId,
      buildingId: tower.id,
      optionId: 'lookout',
      engineerUnitId: commander(g).units.find((u) => u.typeId === 'ww2_engineer')!.id,
    });
    g = step(step(g, { type: 'endTurn' }), { type: 'endTurn' });
    expect(g.active).toBe('A');
    expect(
      campaignNodeViews(g).find((v) => v.nodeId === home(g).nodeId)!.work.operationsRemaining,
    ).toBe(2);
    refusal(
      g,
      {
        kind: 'select-exclusive',
        nodeId: home(g).nodeId,
        buildingId: tower.id,
        optionId: 'comm-hub',
        engineerUnitId: null,
      },
      'unavailable',
    );
    expect(
      campaignBuildingData(node(g, home(g).nodeId).buildings.find((b) => b.id === tower.id)!),
    ).toMatchObject({ exclusiveChoices: ['lookout'] });
    g = resume(g);
    expect(
      campaignBuildingData(node(g, home(g).nodeId).buildings.find((b) => b.id === tower.id)!),
    ).toMatchObject({ exclusiveChoices: ['lookout'] });
  });

  it('TS-005/006/036: activation persists control and center, permits one ruin repair, rejects other same-turn work and unaffordable activation atomically', () => {
    let g = game();
    const site = g.infrastructure!.sites.find(
      (s) => s.homeTeam === null && worldOf(g).world.mainByKey.get(s.mainHex)!.col === 1,
    )!;
    setHolderPos(worldOf(g).world, commander(g), site.annexSubHexes[3]);
    commander(g).units.push(makeUnit(g, 'A', 'ww2_engineer'));
    updateNode(g, site.nodeId, (n) => ({
      ...n,
      buildings: [
        { ...n.buildings[0], ruined: true },
        {
          id: 'old-workshop',
          ruined: true,
          data: {
            ...campaignBuildingData(n.buildings[0]),
            definitionId: 'workshop',
            role: 'workshop',
            specialty: 'industrial',
            placement: 'annex',
            subHex: site.annexSubHexes[0],
            active: true,
          },
        },
      ],
    }));
    const activation: CampaignNodeActionInput = {
      kind: 'activate',
      nodeId: site.nodeId,
      commanderId: commander(g).id,
      centerDefinitionId: 'generic',
    };
    const poor = structuredClone(g);
    poor.cp.A = 4;
    refreshCampaignNodeSnapshot(poor);
    refusal(poor, activation, 'Not enough command points');
    const cp = g.cp.A;
    g = work(g, activation);
    expect(g.cp.A).toBe(cp - 5);
    expect(node(g, site.nodeId).owner).toBe('A');
    expect(campaignBuildingData(node(g, site.nodeId).buildings[0])).toMatchObject({
      definitionId: 'generic',
      active: true,
    });
    const engineers = commander(g).units.filter((u) => u.typeId === 'ww2_engineer');
    g = work(g, {
      kind: 'repair-building',
      nodeId: site.nodeId,
      buildingId: node(g, site.nodeId).buildings[0].id,
      engineerUnitId: engineers[0].id,
    });
    expect(node(g, site.nodeId).buildings[0].ruined).toBe(false);
    refusal(
      g,
      {
        kind: 'repair-building',
        nodeId: site.nodeId,
        buildingId: 'old-workshop',
        engineerUnitId: engineers[1].id,
      },
      'already spent',
    );
    refusal(
      g,
      {
        kind: 'build',
        nodeId: site.nodeId,
        definitionId: 'barracks',
        tier: 1,
        subHex: site.annexSubHexes[1],
        engineerUnitId: null,
      },
      'Activation',
    );
    refusal(
      g,
      {
        kind: 'upgrade',
        nodeId: site.nodeId,
        buildingId: node(g, site.nodeId).buildings[0].id,
        tier: 2,
        engineerUnitId: engineers[1].id,
      },
      'Activation',
    );
    g = resume(g);
    expect(node(g, site.nodeId).buildings.map((b) => b.ruined)).toEqual([false, true]);
  });

  it('TS-011/040: center-first repair restores only its own operation and leaves annex effects inactive until a separate repair', () => {
    let g = game();
    g = work(g, build(g, 'workshop', 1));
    commander(g).units.push(makeUnit(g, 'A', 'ww2_engineer'));
    updateNode(g, home(g).nodeId, (n) => ({
      ...n,
      buildings: n.buildings.map((b) => ({ ...b, ruined: true })),
    }));
    g = step(step(g, { type: 'endTurn' }), { type: 'endTurn' });
    const buildings = node(g, home(g).nodeId).buildings;
    const engineers = commander(g).units.filter((u) => u.typeId === 'ww2_engineer');
    g = work(g, {
      kind: 'repair-building',
      nodeId: home(g).nodeId,
      buildingId: buildings[0].id,
      engineerUnitId: engineers[0].id,
    });
    expect(node(g, home(g).nodeId).buildings.map((b) => b.ruined)).toEqual([false, true]);
    expect(
      campaignNodeViews(g)
        .find((v) => v.nodeId === home(g).nodeId)!
        .buildings.map((b) => b.active),
    ).toEqual([true, false]);
    g = work(g, {
      kind: 'repair-building',
      nodeId: home(g).nodeId,
      buildingId: buildings[1].id,
      engineerUnitId: engineers[1].id,
    });
    expect(
      campaignNodeViews(g)
        .find((v) => v.nodeId === home(g).nodeId)!
        .buildings.map((b) => b.active),
    ).toEqual([true, true]);
  });

  it('TS-033/034/035: player and AI consume one actual configured flow with identical saved action outcomes and durable work/supply/attribute projections', () => {
    let initial = game();
    const types = new Set<string>();
    let count = 0;
    while (initial.active === 'A' && initial.phase !== 'over' && count < 50) {
      const action = aiStep(initial);
      expect(action).not.toBeNull();
      types.add(action!.type);
      const playerPath = step(initial, action!);
      const restored = resume(initial);
      const restoredAction = aiStep(restored);
      expect(restoredAction).toEqual(action);
      const resumedPath = step(restored, restoredAction!);
      expect(resumedPath).toEqual(playerPath);
      initial = playerPath;
      count += 1;
    }
    expect(initial.active).toBe('B');
    expect(count).toBeGreaterThan(2);
    expect(types.has('recruit')).toBe(true);
    expect(types.has('nodeWork')).toBe(true);
    const saved = resume(initial);
    expect(campaignSupplyView(saved, 'A')).toEqual(campaignSupplyView(initial, 'A'));
    expect(campaignIncome(saved, 'A')).toBe(campaignIncome(initial, 'A'));
    expect(saved.infrastructure!.clock!.paidIncomeEvents).toEqual(
      initial.infrastructure!.clock!.paidIncomeEvents,
    );
    expect(saved.infrastructure!.capture.work).toEqual(initial.infrastructure!.capture.work);
  });

  it('TS-057: six raw territorial claims plus eligible 4.4 building income and base3 pay13 once at the legitimate owner opening', () => {
    const c = configuration();
    const g = createGame({
      ...defaultSettings(),
      seed: 1,
      fog: false,
      commanderTrainingCp: 11,
      controllers: { A: 'human', B: 'human' },
      grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
      infrastructure: {
        ...c,
        effects: {
          ...c.effects,
          generic: { ...c.effects.generic, 1: { ...c.effects.generic[1]!, income: 4.4 } },
        },
      },
    });
    const owned = new Set([
      home(g).nodeId,
      ...g
        .infrastructure!.sites.filter((s) => s.homeTeam === null)
        .slice(0, 5)
        .map((s) => s.nodeId),
    ]);
    const f = g.infrastructure!;
    g.infrastructure = {
      ...f,
      capture: {
        ...f.capture,
        nodes: f.capture.nodes.map((n) => (owned.has(n.id) ? { ...n, owner: 'A' as const } : n)),
      },
    };
    syncCampaignClaims(g);
    refreshCampaignNodeSnapshot(g);
    refreshCampaignNetworks(g);
    expect(Object.values(g.hexes).filter((h) => h.owner === 'A')).toHaveLength(6);
    expect(campaignIncome(g, 'A')).toBe(13);
    const cp = g.cp.A;
    const payments = g.infrastructure!.clock!.paidIncomeEvents.length;
    const next = step(step(g, { type: 'endTurn' }), { type: 'endTurn' });
    expect(next.active).toBe('A');
    expect(next.cp.A).toBe(cp + 13);
    expect(next.infrastructure!.clock!.paidIncomeEvents.length).toBe(payments + 2);
    expect(resume(next).cp.A).toBe(cp + 13);
    expect(resume(next).infrastructure!.clock!.paidIncomeEvents).toEqual(
      next.infrastructure!.clock!.paidIncomeEvents,
    );
  });

  it('TS-015: a disconnected island selects the maximum of two Regional HQ allowances rather than adding both', () => {
    const g = game();
    const { world } = worldOf(g);
    const key = (col: number): string =>
      hexKey(world.mains.find((m) => m.col === col && m.row === 0)!.center);
    const supply = evaluateCampaignSupply({
      world,
      terrain: {
        heights: new Int8Array(world.subs.length).fill(1),
        mainHeight: new Map(),
        passes: [],
      },
      team: 'A',
      profile: { ...configuration().supply, legRange: 12, distanceDecay: 0 },
      nodes: [
        {
          id: 'regional-low',
          subHex: key(0),
          authority: 'regional',
          owner: 'A',
          operational: true,
          relayRangeBonus: 0,
        },
        {
          id: 'regional-high',
          subHex: key(1),
          authority: 'regional',
          owner: 'A',
          operational: true,
          relayRangeBonus: 0,
        },
        {
          id: 'target',
          subHex: key(2),
          authority: null,
          owner: 'A',
          operational: true,
          relayRangeBonus: 0,
        },
      ],
      roads: [],
      stationedUnits: [],
      control: projectTerritorialControl({
        mainHexIds: world.mains.map((m) => m.key),
        nodes: [],
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
      ],
      hqBenefits: [
        { authorityId: 'regional-low', contributions: [{ benefitId: 'capacity', value: 6 }] },
        { authorityId: 'regional-high', contributions: [{ benefitId: 'capacity', value: 10 }] },
      ],
    });
    expect(supply.nodes.target.homeConnected).toBe(false);
    expect(supply.nodes.target.connection).toBe('regional');
    expect(supply.benefitSelections.target.capacity).toMatchObject({
      providerId: 'regional-high',
      value: 10,
    });
    expect(supply.benefitSelections.target.capacity.value).not.toBe(16);
  });

  it('TS-010/027: three independent Capture/Raze/Do-nothing choices remain unanswered until explicit none, then commit combined CP once', () => {
    let g = threeChoices();
    const nodes = structuredClone(g.nodes);
    g = selection(selection(g, 'one', 'capture'), 'two', 'raze');
    const before = structuredClone(g);
    expect(g.pending!.choices).toHaveLength(2);
    expect(commitTriple(g)).toMatchObject({ ok: false, code: 'incomplete-choices', state: g });
    expect(g).toEqual(before);
    g = selection(g, 'three', 'none');
    const committed = captureSuccess(commitTriple(g));
    expect(committed.work.commandPoints).toEqual({ A: 30, B: 17 });
    expect(committed.nodes.map((n) => n.owner)).toEqual(['A', null, 'B']);
    expect(committed.nodes[2]).toEqual(nodes[2]);
    expect(committed.nodes[1].buildings.every((b) => b.ruined)).toBe(true);
    expect(committed.nodes[0].buildings.map((b) => b.data)).toEqual(
      nodes[0].buildings.map((b) => b.data),
    );
    expect(committed.work.engineerSpending).toEqual([]);
    const restored = JSON.parse(JSON.stringify(committed)) as FoundationCaptureState;
    expect(captureSuccess(commitTriple(restored, g.version))).toEqual(restored);
    expect(restored.work.commandPoints.A).toBe(30);
  });

  it('TS-028: a fully answered affordable choice batch rejects a stale version without transforming any node or CP', () => {
    const g = selection(
      selection(selection(threeChoices(), 'one', 'capture'), 'two', 'raze'),
      'three',
      'none',
    );
    const before = structuredClone(g);
    expect(g.pending!.choices).toHaveLength(3);
    expect(commitTriple(g, g.version - 1)).toMatchObject({
      ok: false,
      code: 'stale-version',
      state: g,
    });
    expect(g).toEqual(before);
    const committed = captureSuccess(commitTriple(g));
    expect(committed.work.commandPoints.A).toBe(30);
    expect(committed.nodes.map((n) => n.owner)).toEqual(['A', null, 'B']);
  });

  it('TS-029/030: exact .47 hostile shortcut loses to .82 friendly detour, and three cells in one hostile MainHex incur only one .50 penalty', () => {
    const base = {
      team: 'A' as const,
      profile: {
        ...configuration().supply,
        terrainCosts: { land: 1, marsh: 2, shortcut: 0.5, detour: 1.25 },
        maximumClimb: 8,
        maximumDrop: 8,
        legRange: 8,
        distanceFloor: 0.3,
        distanceDecay: 0.06,
        hostileClaimFactor: 0.5,
      },
      roads: [],
      blockers: [],
      connectors: [
        {
          id: 'hq',
          subHex: '0,0',
          authority: 'home' as const,
          owner: 'A' as const,
          operational: true,
          relayRangeBonus: 0,
        },
        {
          id: 'target',
          subHex: '2,0',
          authority: null,
          owner: 'A' as const,
          operational: true,
          relayRangeBonus: 0,
        },
      ],
      claims: { main: 'A' as const, hostile: 'B' as const },
      cells: [
        { key: '0,0', mainHex: 'main', height: 1, terrain: 'shortcut' },
        { key: '1,0', mainHex: 'hostile', height: 1, terrain: 'shortcut' },
        { key: '2,0', mainHex: 'main', height: 1, terrain: 'shortcut' },
      ],
    };
    const shortcut = evaluateSupplyGraph(base).nodes.target.activeRoute!;
    expect(shortcut.weightedCost).toBe(1);
    expect(shortcut.effectiveEfficiency).toBe(0.47);
    const detour = evaluateSupplyGraph({
      ...base,
      cells: [
        ...base.cells,
        { key: '0,1', mainHex: 'main', height: 1, terrain: 'detour' },
        { key: '1,1', mainHex: 'main', height: 1, terrain: 'detour' },
      ],
    }).nodes.target.activeRoute!;
    expect(detour.weightedCost).toBe(3);
    expect(detour.effectiveEfficiency).toBe(0.82);
    expect(detour.hostileMainHexes).toEqual([]);
    const long = evaluateSupplyGraph({
      ...base,
      cells: Array.from({ length: 5 }, (_, i) => ({
        key: `${i},0`,
        mainHex: i > 0 && i < 4 ? 'hostile' : 'main',
        height: 1,
        terrain: 'land',
      })),
      connectors: [base.connectors[0], { ...base.connectors[1], subHex: '4,0' }],
    }).nodes.target.activeRoute!;
    expect(long.hostileMainHexes).toEqual(['hostile']);
    expect(long.effectiveEfficiency).toBe(0.38);
  });

  it('TS-019: actual opening income and a conserved deployment remain paid/spent when a real bridge activation reconnects and boosts the island', () => {
    const fixture = disconnectedNetwork();
    let g = step(step(fixture.state, { type: 'endTurn' }), { type: 'endTurn' });
    const { bridge, remote } = fixture;
    const before = campaignSupplyView(g, 'A')!;
    expect(before.nodes[remote.nodeId].homeConnected).toBe(false);
    expect(before.nodes[remote.nodeId].connection).toBe('regional');
    const incomeEvents = structuredClone(g.infrastructure!.clock!.paidIncomeEvents);
    const openingCp = g.cp.A;
    g = step(g, { type: 'recruit', typeId: 'ww2_rifle_infantry', nodeId: remote.nodeId });
    expect(g.cp.A).toBe(openingCp - 3);
    const deployed = g.armies.find((h) => h.nodeId === remote.nodeId)!.units[0].id;
    const budgets = structuredClone(g.infrastructure!.supply!.reinforcement);
    expect(budgets.receipts).toHaveLength(1);
    expect(budgets.receipts[0].request.units).toBe(1);
    const cp = g.cp.A;
    g = work(g, {
      kind: 'activate',
      nodeId: bridge.nodeId,
      commanderId: commander(g).id,
      centerDefinitionId: 'generic',
    });
    const connected = campaignSupplyView(g, 'A')!;
    expect(connected.nodes[remote.nodeId].homeConnected).toBe(true);
    expect(before.benefitSelections[remote.nodeId].reinforcement).toMatchObject({
      providerId: remote.nodeId,
      value: 14,
    });
    expect(connected.benefitSelections[remote.nodeId].reinforcement).toMatchObject({
      providerId: remote.nodeId,
      value: 17,
      homeConnected: true,
    });
    expect(g.cp.A).toBe(cp - 5);
    expect(g.infrastructure!.clock!.paidIncomeEvents).toEqual(incomeEvents);
    expect(g.infrastructure!.supply!.reinforcement).toEqual(budgets);
    expect(g.armies.flatMap((h) => h.units).some((u) => u.id === deployed)).toBe(true);
    expect(resume(g)).toEqual(g);
  });

  it('TS-026: an actually upgraded disconnected center, existing forts, spent engineer and pending capture sequence restore exactly without a repeated payment', () => {
    const fixture = disconnectedNetwork();
    let g = step(step(fixture.state, { type: 'endTurn' }), { type: 'endTurn' });
    const { remote } = fixture;
    const { world } = worldOf(g);
    setHolderPos(
      world,
      commander(g),
      remote.annexSubHexes.find((key) => !g.armies.some((h) => h.pos === key))!,
    );
    refreshCampaignNodeSnapshot(g);
    const engineer = commander(g).units.find((u) => u.typeId === 'ww2_engineer')!;
    g = work(g, {
      kind: 'upgrade',
      nodeId: remote.nodeId,
      buildingId: node(g, remote.nodeId).buildings[0].id,
      tier: 3,
      engineerUnitId: engineer.id,
    });
    const enemyHome = g.infrastructure!.sites.find((s) => s.homeTeam === 'B')!;
    // Prepared presence is part of the pending-choice fixture, not an earned travel claim.
    setHolderPos(
      world,
      commander(g),
      enemyHome.annexSubHexes.find((key) => !g.armies.some((h) => h.pos === key))!,
    );
    const enemy = g.armies.find((h) => h.team === 'B' && h.kind === 'commander')!;
    const safe = world.subs.find(
      (cell) =>
        !g.infrastructure!.capture.nodes.some((n) => n.mainHex === cell.main && n.owner !== null) &&
        !g.armies.some((h) => h.pos === cell.key),
    )!;
    setHolderPos(world, enemy, safe.key);
    syncCampaignClaims(g);
    refreshCampaignNodeSnapshot(g);
    refreshCampaignNetworks(g);
    g = step(step(g, { type: 'endTurn' }), { type: 'endTurn' });
    expect(g.infrastructure!.capture.pending?.event.kind).toBe('turn-start-after-income');
    expect(g.infrastructure!.capture.pending!.choices).toEqual([]);
    expect(campaignSupplyView(g, 'A')!.nodes[remote.nodeId].homeConnected).toBe(false);
    expect(campaignBuildingData(node(g, remote.nodeId).buildings[0]).tier).toBe(3);
    expect(Object.keys(g.forts).length).toBeGreaterThan(0);
    const projection = campaignSupplyView(g, 'A');
    const payment = g.cp.A;
    const paid = structuredClone(g.infrastructure!.clock!.paidIncomeEvents);
    const history = structuredClone(g.infrastructure!.capture.work.engineerSpending);
    const restored = resume(g);
    expect(restored.cp.A).toBe(payment);
    expect(restored.forts).toEqual(g.forts);
    expect(restored.infrastructure!.capture.pending).toEqual(g.infrastructure!.capture.pending);
    expect(restored.infrastructure!.capture.work.engineerSpending).toEqual(history);
    expect(restored.infrastructure!.clock!.paidIncomeEvents).toEqual(paid);
    expect(campaignSupplyView(restored, 'A')).toEqual(projection);
    expect(apply(restored, { type: 'endTurn' }).error).toContain('pending');
  });

  it('TS-013: manual victory stationing commits one selected enemy guard and switches actual campaign supply onto a legal detour', () => {
    const fixture = disconnectedNetwork(true, false);
    let g = fixture.state;
    const { world } = worldOf(g);
    const before = campaignSupplyView(g, 'A')!;
    const route = before.nodes[fixture.remote.nodeId].activeRoute!;
    expect(route).not.toBeNull();
    const centers = new Set(g.infrastructure!.sites.map((site) => site.centerSubHex));
    const guardCell = route.path.slice(1, -1).find((key) => {
      if (centers.has(key) || g.armies.some((h) => h.pos === key)) return false;
      const probe = structuredClone(g);
      probe.armies.push({
        id: 'probe-guard',
        kind: 'garrison',
        building: 'temporary',
        team: 'B',
        pos: key,
        at: world.subByKey.get(key)!.main,
        movesLeft: 0,
        units: [makeUnit(probe, 'B', 'ww2_rifle_infantry')],
      });
      return campaignSupplyView(probe, 'A')!.nodes[fixture.remote.nodeId].activeRoute !== null;
    });
    expect(guardCell).toBeDefined();
    const main = world.subByKey.get(guardCell!)!.main;
    const positions = world.mainByKey
      .get(main)!
      .subKeys.filter(
        (key) =>
          key !== guardCell &&
          !centers.has(key) &&
          !g.armies.some((h) => h.kind === 'garrison' && h.pos === key),
      );
    const mine = commander(g);
    const enemy = g.armies.find((h) => h.team === 'B' && h.kind === 'commander')!;
    setHolderPos(world, mine, positions[0]);
    setHolderPos(world, enemy, positions[1]);
    g.forts[guardCell!] = 1; // Existing eligible fort; no engineer/provenance is manufactured.
    syncCampaignClaims(g);
    refreshCampaignNodeSnapshot(g);
    refreshCampaignNetworks(g);
    g = step(g, { type: 'endTurn' });
    const attacker = g.armies.find((h) => h.id === enemy.id)!;
    g = step(g, { type: 'engage', armyId: attacker.id, targetId: mine.id });
    g = step(g, { type: 'startBattle' });
    g = step(step(g, { type: 'finishDeploy' }), { type: 'finishDeploy' });
    const battle = g.battle!;
    const selected = battle.units.find((u) => u.team === 'B')!;
    const otherCells = battle.mains
      .flatMap((key) => world.mainByKey.get(key)!.subKeys)
      .filter((key) => key !== guardCell && !centers.has(key) && !(battle.forts[key] ?? 0));
    let cursor = 0;
    for (const unit of battle.units)
      unit.pos = unit.id === selected.id ? guardCell! : otherCells[cursor++];
    battle.phase = 'over';
    battle.winner = 'B';
    battle.endReason = 'Prepared manual victory for supply-stationing acceptance';
    g = step(g, { type: 'concludeBattle' });
    expect(g.infrastructure!.capture.pending).toBeNull();
    expect(
      g.infrastructure!.garrisons!.pendingStationing!.candidates.some(
        (c) => c.unitId === selected.id && c.subHex === guardCell,
      ),
    ).toBe(true);
    expect(campaignSupplyView(g, 'A')!.nodes[fixture.remote.nodeId].activeRoute!.path).toContain(
      guardCell,
    );
    g = step(g, { type: 'stationingToggle', unitId: selected.id });
    g = step(resume(g), { type: 'stationingCommit' });
    expect(g.phase).toBe('strategic');
    const stationed = g.armies.filter((h) => h.building === 'temporary');
    expect(stationed).toHaveLength(1);
    expect(stationed[0]).toMatchObject({ team: 'B', pos: guardCell, units: [{ id: selected.id }] });
    const detour = campaignSupplyView(g, 'A')!;
    expect(detour.blockedCells).toContain(guardCell);
    expect(detour.nodes[fixture.remote.nodeId].activeRoute).not.toBeNull();
    expect(detour.nodes[fixture.remote.nodeId].activeRoute!.path).not.toContain(guardCell);
    expect(detour.nodes[fixture.remote.nodeId].activeRoute!.path).not.toEqual(route.path);
    expect(resume(g)).toEqual(g);
  });

  it.each(['capture', 'raze', 'none'] as const)(
    'TS-051: a saved complete Home HQ %s choice pays once and projects claim before the retained victory condition',
    (outcome) => {
      let g = game();
      const { world } = worldOf(g);
      const enemyHome = g.infrastructure!.sites.find((s) => s.homeTeam === 'B')!;
      setHolderPos(
        world,
        commander(g),
        enemyHome.annexSubHexes.find((key) => !g.armies.some((h) => h.pos === key))!,
      );
      const enemy = g.armies.find((h) => h.team === 'B' && h.kind === 'commander')!;
      const empty = world.subs.find(
        (cell) =>
          cell.main !== enemyHome.mainHex &&
          cell.main !== g.hq.A &&
          !g.armies.some((h) => h.pos === cell.key),
      )!;
      setHolderPos(world, enemy, empty.key);
      syncCampaignClaims(g);
      refreshCampaignNodeSnapshot(g);
      refreshCampaignNetworks(g);
      g = step(step(g, { type: 'endTurn' }), { type: 'endTurn' });
      expect(g.infrastructure!.capture.pending!.candidates.map((c) => c.node.id)).toEqual([
        enemyHome.nodeId,
      ]);
      expect(g.winner).toBeNull();
      g = step(g, { type: 'captureChoice', nodeId: enemyHome.nodeId, outcome });
      g = resume(g);
      const cp = g.cp.A;
      const paid = structuredClone(g.infrastructure!.clock!.paidIncomeEvents);
      g = step(g, { type: 'captureCommit' });
      expect(g.cp.A).toBe(cp - (outcome === 'capture' ? 7 : outcome === 'raze' ? 3 : 0));
      expect(g.infrastructure!.clock!.paidIncomeEvents).toEqual(paid);
      expect(g.infrastructure!.capture.pending).toBeNull();
      expect(node(g, enemyHome.nodeId).owner).toBe(
        outcome === 'capture' ? 'A' : outcome === 'raze' ? null : 'B',
      );
      expect(g.hexes[enemyHome.mainHex].owner).toBe(outcome === 'none' ? 'B' : 'A');
      expect(g.winner).toBe(outcome === 'none' ? null : 'A');
      expect(g.phase).toBe(outcome === 'none' ? 'strategic' : 'over');
      const receipt = g.infrastructure!.capture.receipts.at(-1)!;
      expect(receipt.cpSpent).toBe(outcome === 'capture' ? 7 : outcome === 'raze' ? 3 : 0);
      expect(resume(g)).toEqual(g);
    },
  );
});
