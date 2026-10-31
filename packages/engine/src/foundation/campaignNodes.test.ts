import { describe, expect, it } from 'vitest';
import { buildWorld } from '../grid.ts';
import { hexDistance, parseKey } from '../hex.ts';
import { COMMAND, createGame, defaultSettings, worldOf } from '../strategic.ts';
import { createBattle } from '../tactical.ts';
import type { Army } from '../types.ts';
import {
  applyCampaignNodeAction,
  campaignBuildingData,
  campaignNodeSites,
  chooseCampaignCapture,
  commitCampaignCapture,
  createCampaignInfrastructure,
  openCampaignNodeTurn,
  prepareCampaignCapture,
  refreshCampaignNodeSnapshot,
  validateCampaignInfrastructure,
  validateCampaignNodeProfile,
  campaignNodeViews,
  campaignNodeActionChoices,
} from './campaignNodes.ts';
import type {
  CampaignNodeAction,
  CampaignNodeDefinition,
  CampaignNodeGameState,
  CampaignNodeProfile,
  CampaignNodeSite,
} from './campaignNodes.ts';
import { createCampaignGarrisonState } from './campaignGarrisons.ts';

/** Synthetic test-only prices; these do not select production tuning. */
function profile(): CampaignNodeProfile {
  const definition: CampaignNodeDefinition = {
    id: 'center',
    name: 'Generic center',
    role: 'center',
    specialty: 'generic',
    centerEligible: true,
    annexEligible: false,
    minimumGenericCenterTier: 1,
    maximumTier: 3,
    prerequisites: [],
    specialtyExceptions: [],
    engineerRequired: false,
    costs: { build: { 1: 2, 2: 4, 3: 6 }, upgrade: { 2: 5, 3: 7 }, repair: { 1: 3, 2: 4, 3: 5 } },
    exclusiveUpgrades: [
      { id: 'lookout', cpCost: 2, engineerRequired: false },
      { id: 'signal', cpCost: 2, engineerRequired: false },
    ],
    slotlessUnlocks: [{ id: 'roads', cpCost: 1, engineerRequired: false }],
  };
  return {
    id: 'test-profile',
    activationCp: 4,
    captureCosts: { capture: 7, raze: 3 },
    initialGenericCenterDefinitionId: 'center',
    homeCenterDefinitionId: 'center',
    homeCenterTier: 1,
    activationCenterDefinitionIds: ['center'],
    definitions: [
      definition,
      {
        ...definition,
        id: 'workshop',
        name: 'Workshop',
        role: 'workshop',
        centerEligible: false,
        annexEligible: true,
      },
      {
        ...definition,
        id: 'hospital',
        name: 'Hospital',
        role: 'hospital',
        specialty: 'medical',
        centerEligible: false,
        annexEligible: true,
        engineerRequired: true,
        prerequisites: ['workshop'],
      },
    ],
  };
}

function game(): CampaignNodeGameState {
  const state = createGame({
    ...defaultSettings(),
    grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
  });
  state.cp = { A: 100, B: 100 };
  const commander = state.armies.find((a) => a.team === 'A' && a.kind === 'commander')!;
  for (const n of [1, 2])
    commander.units.push({
      id: `test-engineer-${n}`,
      typeId: 'ww2_engineer',
      hp: 10,
      label: 'Engineer',
    });
  const { world } = worldOf(state);
  state.infrastructure = createCampaignInfrastructure(state, world, profile());
  return state;
}

type Payload<T = CampaignNodeAction> = T extends CampaignNodeAction
  ? Omit<T, 'requestId' | 'expectedVersion' | 'ownerTurnId'>
  : never;
function request(state: CampaignNodeGameState, body: Payload): CampaignNodeAction {
  return {
    ...body,
    requestId: `node-action-${state.infrastructure!.capture.version}`,
    expectedVersion: state.infrastructure!.capture.version,
    ownerTurnId: state.infrastructure!.ownerTurns[state.active],
  } as CampaignNodeAction;
}
function apply(state: CampaignNodeGameState, body: Payload): CampaignNodeAction {
  const action = request(state, body);
  const result = applyCampaignNodeAction(state, worldOf(state).world, action);
  if (!result.ok) throw new Error(result.error);
  expect(
    validateCampaignInfrastructure(state.infrastructure!, worldOf(state).world, state.hq),
  ).toBeNull();
  return action;
}
function reject(state: CampaignNodeGameState, body: Payload, message: string): void {
  const before = JSON.stringify(state);
  expect(applyCampaignNodeAction(state, worldOf(state).world, request(state, body))).toMatchObject({
    ok: false,
    error: expect.stringContaining(message),
  });
  expect(JSON.stringify(state)).toBe(before);
}
function home(state: CampaignNodeGameState): CampaignNodeSite {
  return state.infrastructure!.sites.find((s) => s.homeTeam === 'A')!;
}
function nextTurn(state: CampaignNodeGameState): void {
  state.turn++;
  state.active = 'A';
  openCampaignNodeTurn(state);
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: actual campaign nodes', () => {
  it('creates exactly seven in-MainHex cells per site across all supported sub-radius sizes', () => {
    for (const subRadius of [2, 3, 4, 5, 6]) {
      const world = buildWorld({ mainCols: 3, mainRows: 3, subRadius });
      const hq = { A: world.mains[0].key, B: world.mains.at(-1)!.key };
      const sites = campaignNodeSites(world, hq);
      expect(sites).toHaveLength(world.mains.length);
      expect(campaignNodeSites(world, hq)).toEqual(sites);
      for (const site of sites) {
        expect(new Set([site.centerSubHex, ...site.annexSubHexes]).size).toBe(7);
        for (const key of site.annexSubHexes) {
          expect(world.subByKey.get(key)!.main).toBe(site.mainHex);
          expect(hexDistance(parseKey(key), parseKey(site.centerSubHex))).toBe(1);
        }
      }
    }
  });

  it('retains existing armies, forts, CP and RNG, mapping HQ holders without reducing cap12', () => {
    const state = createGame(defaultSettings());
    const before = JSON.stringify(state);
    const infra = createCampaignInfrastructure(state, worldOf(state).world, profile());
    expect(JSON.stringify(state)).toBe(before);
    expect(COMMAND.garrisonCap).toBe(12);
    expect(infra.capture.nodes.filter((n) => n.owner !== null)).toHaveLength(2);
    for (const site of infra.sites) {
      const node = infra.capture.nodes.find((n) => n.id === site.nodeId)!;
      expect(campaignBuildingData(node.buildings[0]).active).toBe(site.homeTeam !== null);
      if (site.homeTeam)
        expect(
          state.armies.some(
            (a) => a.kind === 'garrison' && a.building === 'hq' && a.pos === site.centerSubHex,
          ),
        ).toBe(true);
    }
    expect(infra.capture.work.commandPoints).toEqual(state.cp);
  });

  it('requires explicit prices and validates saved geometry instead of guessing', () => {
    const valid = profile();
    expect(validateCampaignNodeProfile(valid)).toBeNull();
    expect(
      validateCampaignNodeProfile({
        ...valid,
        definitions: [
          { ...valid.definitions[0], costs: { ...valid.definitions[0].costs, upgrade: {} } },
        ],
      }),
    ).not.toBeNull();
    const state = game();
    const infra = state.infrastructure!;
    const invalid = {
      ...infra,
      sites: infra.sites.map((s, i) =>
        i === 0 ? { ...s, annexSubHexes: [s.centerSubHex, ...s.annexSubHexes.slice(1)] } : s,
      ),
    };
    expect(validateCampaignInfrastructure(invalid, worldOf(state).world, state.hq)).toContain(
      'geometry',
    );
  });

  it('activates through actual commander presence, then closes construction until the next owner cycle', () => {
    const state = game();
    const site = state.infrastructure!.sites.find((s) => state.hexes[s.mainHex].owner === null)!;
    const commander = state.armies.find((a) => a.team === 'A' && a.kind === 'commander')!;
    commander.at = site.mainHex;
    commander.pos = site.annexSubHexes[0];
    refreshCampaignNodeSnapshot(state);
    const activation = apply(state, {
      kind: 'activate',
      nodeId: site.nodeId,
      commanderId: commander.id,
      centerDefinitionId: 'center',
    });
    expect(state.cp.A).toBe(96);
    expect(state.infrastructure!.capture.nodes.find((n) => n.id === site.nodeId)!.owner).toBe('A');
    reject(
      state,
      {
        kind: 'build',
        nodeId: site.nodeId,
        subHex: site.annexSubHexes[0],
        definitionId: 'workshop',
        tier: 1,
        engineerUnitId: null,
      },
      'Activation',
    );
    const beforeReplay = JSON.stringify(state);
    expect(applyCampaignNodeAction(state, worldOf(state).world, activation)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(JSON.stringify(state)).toBe(beforeReplay);
    const oldSpending = state.infrastructure!.capture.work.nodeSpending;
    nextTurn(state);
    apply(state, {
      kind: 'build',
      nodeId: site.nodeId,
      subHex: site.annexSubHexes[0],
      definitionId: 'workshop',
      tier: 1,
      engineerUnitId: null,
    });
    expect(state.cp.A).toBe(94);
    expect(state.infrastructure!.capture.work.nodeSpending).toContainEqual(oldSpending[0]);
  });

  it('rejects absent/enemy commanders and hostile center occupation without spending', () => {
    const state = game();
    const site = state.infrastructure!.sites.find((s) => state.hexes[s.mainHex].owner === null)!;
    const commander = state.armies.find((a) => a.team === 'A' && a.kind === 'commander')!;
    const enemy = state.armies.find((a) => a.team === 'B' && a.kind === 'commander')!;
    reject(
      state,
      {
        kind: 'activate',
        nodeId: site.nodeId,
        commanderId: commander.id,
        centerDefinitionId: 'center',
      },
      'MainHex',
    );
    commander.at = site.mainHex;
    commander.pos = site.annexSubHexes[0];
    enemy.at = site.mainHex;
    enemy.pos = site.centerSubHex;
    refreshCampaignNodeSnapshot(state);
    reject(
      state,
      {
        kind: 'activate',
        nodeId: site.nodeId,
        commanderId: enemy.id,
        centerDefinitionId: 'center',
      },
      'friendly',
    );
    reject(
      state,
      {
        kind: 'activate',
        nodeId: site.nodeId,
        commanderId: commander.id,
        centerDefinitionId: 'center',
      },
      'hostile unit',
    );
  });

  it('applies center upgrades and ordinary builds through real CP and engineer ledgers', () => {
    const state = game();
    const site = home(state);
    const center = state.infrastructure!.capture.nodes.find((n) => n.id === site.nodeId)!
      .buildings[0];
    reject(
      state,
      {
        kind: 'upgrade',
        nodeId: site.nodeId,
        buildingId: center.id,
        tier: 2,
        engineerUnitId: null,
      },
      'engineer',
    );
    const upgrade = apply(state, {
      kind: 'upgrade',
      nodeId: site.nodeId,
      buildingId: center.id,
      tier: 2,
      engineerUnitId: 'test-engineer-1',
    });
    apply(state, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'workshop',
      subHex: site.annexSubHexes[0],
      tier: 2,
      engineerUnitId: null,
    });
    expect(state.cp.A).toBe(91);
    const spend = state.infrastructure!.capture.work.nodeSpending[0];
    expect(spend).toMatchObject({ ordinarySpent: true, operationCount: 2 });
    expect(state.infrastructure!.capture.work.engineerSpending).toHaveLength(1);
    reject(
      state,
      {
        kind: 'build',
        nodeId: site.nodeId,
        definitionId: 'workshop',
        subHex: site.annexSubHexes[1],
        tier: 1,
        engineerUnitId: 'test-engineer-2',
      },
      'two operations',
    );
    const before = JSON.stringify(state);
    expect(applyCampaignNodeAction(state, worldOf(state).world, upgrade)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('validates slot, tier and definition prerequisites before any CP or ledger mutation', () => {
    const state = game();
    const site = home(state);
    reject(
      state,
      {
        kind: 'build',
        nodeId: site.nodeId,
        definitionId: 'missing',
        subHex: site.annexSubHexes[0],
        tier: 1,
        engineerUnitId: null,
      },
      'Unknown building',
    );
    reject(
      state,
      {
        kind: 'build',
        nodeId: site.nodeId,
        definitionId: 'workshop',
        subHex: 'off-map',
        tier: 1,
        engineerUnitId: null,
      },
      'slot',
    );
    reject(
      state,
      {
        kind: 'build',
        nodeId: site.nodeId,
        definitionId: 'workshop',
        subHex: site.annexSubHexes[0],
        tier: 2,
        engineerUnitId: null,
      },
      'ineligible',
    );
    reject(
      state,
      {
        kind: 'build',
        nodeId: site.nodeId,
        definitionId: 'hospital',
        subHex: site.annexSubHexes[0],
        tier: 1,
        engineerUnitId: 'test-engineer-1',
      },
      'prerequisites',
    );
    apply(state, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'workshop',
      subHex: site.annexSubHexes[0],
      tier: 1,
      engineerUnitId: null,
    });
    reject(
      state,
      {
        kind: 'build',
        nodeId: site.nodeId,
        definitionId: 'workshop',
        subHex: site.annexSubHexes[0],
        tier: 1,
        engineerUnitId: 'test-engineer-1',
      },
      'slot',
    );
    apply(state, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'hospital',
      subHex: site.annexSubHexes[1],
      tier: 1,
      engineerUnitId: 'test-engineer-1',
    });
  });

  it('repairs annex then center with persistent upgrades and separate engineer actions', () => {
    const state = game();
    const site = home(state);
    apply(state, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'workshop',
      subHex: site.annexSubHexes[0],
      tier: 1,
      engineerUnitId: null,
    });
    const original = state.infrastructure!;
    state.infrastructure = {
      ...original,
      capture: {
        ...original.capture,
        nodes: original.capture.nodes.map((n) =>
          n.id === site.nodeId
            ? { ...n, buildings: n.buildings.map((b) => ({ ...b, ruined: true })) }
            : n,
        ),
      },
    };
    nextTurn(state);
    const buildings = state.infrastructure!.capture.nodes.find(
      (n) => n.id === site.nodeId,
    )!.buildings;
    apply(state, {
      kind: 'repair-building',
      nodeId: site.nodeId,
      buildingId: buildings[1].id,
      engineerUnitId: 'test-engineer-1',
    });
    const partly = state.infrastructure!.capture.nodes.find((n) => n.id === site.nodeId)!;
    expect(partly.buildings.map((b) => b.ruined)).toEqual([true, false]);
    apply(state, {
      kind: 'repair-building',
      nodeId: site.nodeId,
      buildingId: buildings[0].id,
      engineerUnitId: 'test-engineer-2',
    });
    expect(
      state
        .infrastructure!.capture.nodes.find((n) => n.id === site.nodeId)!
        .buildings.map((b) => b.ruined),
    ).toEqual([false, false]);
    expect(state.cp.A).toBe(92);
  });

  it('persists one exclusive choice and slotless unlocks through exact JSON resume', () => {
    const state = game();
    const site = home(state);
    const building = state.infrastructure!.capture.nodes.find((n) => n.id === site.nodeId)!
      .buildings[0];
    apply(state, {
      kind: 'select-exclusive',
      nodeId: site.nodeId,
      buildingId: building.id,
      optionId: 'lookout',
      engineerUnitId: null,
    });
    reject(
      state,
      {
        kind: 'select-exclusive',
        nodeId: site.nodeId,
        buildingId: building.id,
        optionId: 'signal',
        engineerUnitId: 'test-engineer-1',
      },
      'unavailable',
    );
    apply(state, {
      kind: 'unlock',
      nodeId: site.nodeId,
      buildingId: building.id,
      optionId: 'roads',
      engineerUnitId: 'test-engineer-1',
    });
    const resumed = JSON.parse(JSON.stringify(state)) as CampaignNodeGameState;
    expect(
      validateCampaignInfrastructure(resumed.infrastructure!, worldOf(resumed).world, resumed.hq),
    ).toBeNull();
    const data = campaignBuildingData(
      resumed.infrastructure!.capture.nodes.find((n) => n.id === site.nodeId)!.buildings[0],
    );
    expect(data.exclusiveChoices).toEqual(['lookout']);
    expect(data.unlocks).toEqual(['roads']);
    expect(resumed.infrastructure!.capture.work.nodeSpending).toEqual(
      state.infrastructure!.capture.work.nodeSpending,
    );
    const before = JSON.stringify(resumed);
    openCampaignNodeTurn(resumed);
    expect(JSON.stringify(resumed)).toBe(before);
  });

  it('requires fresh snapshot after external CP changes and rejects stale work without mutation', () => {
    const state = game();
    const site = home(state);
    const action = request(state, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'workshop',
      subHex: site.annexSubHexes[0],
      tier: 1,
      engineerUnitId: null,
    });
    state.cp.A--;
    expect(applyCampaignNodeAction(state, worldOf(state).world, action)).toMatchObject({
      ok: false,
      error: expect.stringContaining('CP snapshot'),
    });
    refreshCampaignNodeSnapshot(state);
    const before = JSON.stringify(state);
    expect(applyCampaignNodeAction(state, worldOf(state).world, action)).toMatchObject({
      ok: false,
      error: expect.stringContaining('stale'),
    });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('previews actual legal requests, CP and consumed engineer without mutating game state', () => {
    const state = game();
    const site = home(state);
    const before = JSON.stringify(state);
    const choices = campaignNodeActionChoices(state, site.nodeId);
    const repeated = campaignNodeActionChoices(state, site.nodeId);
    expect(repeated).toEqual(choices);
    expect(JSON.stringify(state)).toBe(before);
    const upgrade = choices.find((c) => c.request.kind === 'upgrade' && c.legal)!;
    expect(upgrade).toMatchObject({
      cpCost: 5,
      allowance: 'engineer',
    });
    const selectedEngineer = state.armies
      .flatMap((h) => h.units)
      .find((u) => u.id === upgrade.engineerUnitId)!;
    expect(selectedEngineer.typeId).toBe('ww2_engineer');
    expect(upgrade.engineerLabel).toBe(selectedEngineer.label);
    const first = choices.find(
      (c) => c.request.kind === 'build' && c.request.definitionId === 'workshop' && c.legal,
    )!;
    expect(first).toMatchObject({ cpCost: 2, engineerUnitId: null, allowance: 'ordinary' });
    expect(applyCampaignNodeAction(state, worldOf(state).world, first.request)).toMatchObject({
      ok: true,
    });
    const second = campaignNodeActionChoices(state, site.nodeId).find(
      (c) => c.request.kind === 'build' && c.request.definitionId === 'workshop' && c.legal,
    )!;
    expect(second).toMatchObject({
      cpCost: 2,
      engineerUnitId: selectedEngineer.id,
      allowance: 'engineer',
    });
    expect(second.request.requestId).not.toBe(first.request.requestId);
    expect(applyCampaignNodeAction(state, worldOf(state).world, second.request)).toMatchObject({
      ok: true,
    });
    expect(state.cp.A).toBe(96);
    expect(campaignNodeActionChoices(state, site.nodeId).every((c) => !c.legal && !!c.reason)).toBe(
      true,
    );
  });

  it('shows claim, work window and center-gated operational building facts', () => {
    const state = game();
    const site = home(state);
    apply(state, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'workshop',
      subHex: site.annexSubHexes[0],
      tier: 1,
      engineerUnitId: null,
    });
    const before = JSON.stringify(state);
    const view = campaignNodeViews(state).find((v) => v.nodeId === site.nodeId)!;
    expect(view).toMatchObject({
      name: 'Alpha Home HQ',
      status: 'active',
      owner: 'A',
      claim: 'A',
      contested: false,
      work: { ordinaryRemaining: 0, operationsRemaining: 1, buildingWindow: 'open' },
    });
    expect(view.buildings.every((b) => b.active)).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
    const f = state.infrastructure!;
    state.infrastructure = {
      ...f,
      capture: {
        ...f.capture,
        nodes: f.capture.nodes.map((n) =>
          n.id === site.nodeId
            ? { ...n, buildings: n.buildings.map((b, i) => (i === 0 ? { ...b, ruined: true } : b)) }
            : n,
        ),
      },
    };
    const ruined = campaignNodeViews(state).find((v) => v.nodeId === site.nodeId)!;
    expect(ruined.status).toBe('ruined');
    expect(ruined.buildings.every((b) => !b.active)).toBe(true);
  });

  it('blocks direct node actions and legal previews while stationing input is pending', () => {
    const state = game();
    const site = home(state);
    const holder = state.armies.find((a) => a.team === 'A' && a.kind === 'commander')!;
    const unit = holder.units[0];
    state.infrastructure = {
      ...state.infrastructure!,
      garrisons: {
        ...createCampaignGarrisonState(),
        pendingStationing: {
          battleId: 'manual-pending',
          winner: 'A',
          version: 0,
          selectedUnitIds: [],
          candidates: [
            {
              unitId: unit.id,
              holderId: holder.id,
              label: unit.label,
              typeId: unit.typeId,
              hp: unit.hp,
              subHex: holder.pos,
              tileKind: 'outpost',
            },
          ],
        },
      },
    };
    reject(
      state,
      {
        kind: 'build',
        nodeId: site.nodeId,
        definitionId: 'workshop',
        subHex: site.annexSubHexes[0],
        tier: 1,
        engineerUnitId: null,
      },
      'pending event',
    );
    const before = JSON.stringify(state);
    expect(
      campaignNodeActionChoices(state, site.nodeId).every(
        (choice) => !choice.legal && !!choice.reason,
      ),
    ).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('shows tactical annex Raze immediately without changing persisted tier or upgrade selections', () => {
    const state = game();
    const site = home(state);
    apply(state, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'workshop',
      subHex: site.annexSubHexes[0],
      tier: 1,
      engineerUnitId: null,
    });
    const annex = state.infrastructure!.capture.nodes.find((node) => node.id === site.nodeId)!
      .buildings[1];
    apply(state, {
      kind: 'select-exclusive',
      nodeId: site.nodeId,
      buildingId: annex.id,
      optionId: 'lookout',
      engineerUnitId: 'test-engineer-1',
    });
    const originalBuildings = structuredClone(
      state.infrastructure!.capture.nodes.find((node) => node.id === site.nodeId)!.buildings,
    );
    const a = state.armies.find((holder) => holder.team === 'A' && holder.kind === 'commander')!;
    const b = state.armies.find((holder) => holder.team === 'B' && holder.kind === 'commander')!;
    state.battle = createBattle(state, a, b, a.at, site.mainHex, worldOf(state).world);
    state.phase = 'battle';
    state.battle.ruinedInfrastructureBuildingIds = [annex.id];
    const before = JSON.stringify(state);
    const view = campaignNodeViews(state).find((node) => node.nodeId === site.nodeId)!;
    expect(view.status).toBe('active');
    expect(view.buildings.find((building) => building.id === annex.id)).toMatchObject({
      ruined: true,
      active: false,
      tier: 1,
      placement: 'annex',
    });
    expect(view.buildings.find((building) => building.placement === 'center')).toMatchObject({
      ruined: false,
      active: true,
    });
    expect(
      state.infrastructure!.capture.nodes.find((node) => node.id === site.nodeId)!.buildings,
    ).toEqual(originalBuildings);
    expect(
      campaignBuildingData(
        state.infrastructure!.capture.nodes.find((node) => node.id === site.nodeId)!.buildings[1],
      ).exclusiveChoices,
    ).toEqual(['lookout']);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: actual campaign capture evidence', () => {
  function atEnemyCenter(state: CampaignNodeGameState): {
    site: CampaignNodeSite;
    mine: Army;
    enemy: Army;
  } {
    const site = state.infrastructure!.sites.find((s) => s.homeTeam === 'B')!;
    const mine = state.armies.find((a) => a.team === 'A' && a.kind === 'commander')!;
    const enemy = state.armies.find((a) => a.team === 'B' && a.kind === 'commander')!;
    const other = state.infrastructure!.sites.find(
      (s) => s.homeTeam === null && s.mainHex !== site.mainHex,
    )!;
    enemy.at = other.mainHex;
    enemy.pos = other.centerSubHex;
    mine.at = site.mainHex;
    mine.pos = site.annexSubHexes[0];
    refreshCampaignNodeSnapshot(state);
    return { site, mine, enemy };
  }
  function decide(
    state: CampaignNodeGameState,
    nodeId: string,
    outcome: 'capture' | 'raze' | 'none',
  ): void {
    const pending = state.infrastructure!.capture.pending!;
    expect(
      chooseCampaignCapture(state, {
        requestId: 'selection',
        expectedVersion: state.infrastructure!.capture.version,
        batchId: pending.request.requestId,
        nodeId,
        outcome,
      }),
    ).toMatchObject({ ok: true });
    expect(
      commitCampaignCapture(state, {
        requestId: 'commit',
        expectedVersion: state.infrastructure!.capture.version,
        batchId: pending.request.requestId,
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateCampaignInfrastructure(state.infrastructure!, worldOf(state).world, state.hq),
    ).toBeNull();
  }

  it('starts early capture from actual commander MainHex presence while leaving troops untouched', () => {
    const state = game();
    const { site } = atEnemyCenter(state);
    const armies = JSON.stringify(state.armies);
    const result = prepareCampaignCapture(state, worldOf(state).world, {
      requestId: 'start',
      expectedVersion: state.infrastructure!.capture.version,
      event: { kind: 'turn-start-after-income', incomeReceiptId: 'paid-A:1' },
    });
    expect(result).toMatchObject({ ok: true });
    expect(state.infrastructure!.capture.pending).not.toBeNull();
    decide(state, site.nodeId, 'capture');
    expect(state.cp.A).toBe(93);
    expect(JSON.stringify(state.armies)).toBe(armies);
    expect(state.infrastructure!.capture.work.nodeSpending[0]).toMatchObject({
      operationCount: 0,
      ordinarySpent: false,
      buildingWindow: 'open',
    });
  });

  it('requires center later in the turn and allows normal Do nothing without altering node', () => {
    const state = game();
    const { site, mine } = atEnemyCenter(state);
    const event = { kind: 'strategic-movement' as const, movementReceiptId: 'move-1' };
    prepareCampaignCapture(state, worldOf(state).world, {
      requestId: 'later',
      expectedVersion: state.infrastructure!.capture.version,
      event,
    });
    expect(state.infrastructure!.capture.pending).toBeNull();
    mine.pos = site.centerSubHex;
    refreshCampaignNodeSnapshot(state);
    prepareCampaignCapture(state, worldOf(state).world, {
      requestId: 'later',
      expectedVersion: state.infrastructure!.capture.version,
      event,
    });
    expect(state.infrastructure!.capture.pending).not.toBeNull();
    decide(state, site.nodeId, 'none');
    expect(state.cp.A).toBe(100);
    expect(state.infrastructure!.capture.nodes.find((n) => n.id === site.nodeId)!.owner).toBe('B');
  });

  it('limits movement capture to the moved-controller scope without reopening an unrelated Do nothing', () => {
    const state = game();
    const { site, mine } = atEnemyCenter(state);
    mine.pos = site.centerSubHex;
    refreshCampaignNodeSnapshot(state);
    expect(
      prepareCampaignCapture(state, worldOf(state).world, {
        requestId: 'movement-original',
        expectedVersion: state.infrastructure!.capture.version,
        event: { kind: 'strategic-movement', movementReceiptId: 'move-1' },
        nodeIds: [site.nodeId],
      }),
    ).toMatchObject({ ok: true });
    decide(state, site.nodeId, 'none');
    const before = JSON.stringify(state);
    expect(
      prepareCampaignCapture(state, worldOf(state).world, {
        requestId: 'other-move',
        expectedVersion: state.infrastructure!.capture.version,
        event: { kind: 'strategic-movement', movementReceiptId: 'move-2' },
        nodeIds: [],
      }),
    ).toMatchObject({ ok: true });
    expect(JSON.stringify(state)).toBe(before);
    for (const input of [
      {
        event: { kind: 'strategic-movement' as const, movementReceiptId: 'bad' },
        nodeIds: ['missing'],
      },
      {
        event: { kind: 'turn-start-after-income' as const, incomeReceiptId: 'paid' },
        nodeIds: [site.nodeId],
      },
      { event: { kind: 'manual-battle-end' as const, battleId: 'battle' }, nodeIds: [] },
    ])
      expect(
        prepareCampaignCapture(state, worldOf(state).world, {
          ...input,
          requestId: 'invalid-filter',
          expectedVersion: state.infrastructure!.capture.version,
        }),
      ).toMatchObject({ ok: false, error: expect.stringContaining('movement-node scope') });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('does not strategically capture through hostile troops elsewhere in the MainHex', () => {
    const state = game();
    const { site, mine, enemy } = atEnemyCenter(state);
    mine.pos = site.centerSubHex;
    enemy.at = site.mainHex;
    enemy.pos = site.annexSubHexes[1];
    refreshCampaignNodeSnapshot(state);
    prepareCampaignCapture(state, worldOf(state).world, {
      requestId: 'contested',
      expectedVersion: state.infrastructure!.capture.version,
      event: { kind: 'strategic-movement', movementReceiptId: 'move' },
    });
    expect(state.infrastructure!.capture.pending).toBeNull();
    expect(state.cp.A).toBe(100);
  });

  it('freezes final manual BattleUnits before cleanup, independent of winner and other survivors', () => {
    const state = game();
    const { site, mine, enemy } = atEnemyCenter(state);
    state.battle = createBattle(state, mine, enemy, mine.at, site.mainHex, worldOf(state).world);
    state.battle.phase = 'over';
    state.battle.winner = 'B';
    state.phase = 'battle';
    const attacker = state.battle.units.find((u) => u.team === 'A')!;
    attacker.pos = site.centerSubHex;
    const defender = state.battle.units.find((u) => u.team === 'B')!;
    defender.pos = site.annexSubHexes[1];
    prepareCampaignCapture(state, worldOf(state).world, {
      requestId: 'manual',
      expectedVersion: state.infrastructure!.capture.version,
      event: { kind: 'manual-battle-end', battleId: state.battle.id },
    });
    expect(state.infrastructure!.capture.pending).not.toBeNull();
    const before = JSON.stringify(state.armies);
    decide(state, site.nodeId, 'capture');
    expect(state.infrastructure!.capture.work.nodeSpending[0]).toMatchObject({
      buildingWindow: 'closed',
      ordinarySpent: false,
      operationCount: 0,
    });
    expect(JSON.stringify(state.armies)).toBe(before);
  });
});
