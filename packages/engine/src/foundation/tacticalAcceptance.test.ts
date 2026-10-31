// GAMES-ELEVATE-TACTICAL-UC-001: full selected side-tile Raze acceptance, with positive controls.
import { describe, expect, it } from 'vitest';
import { apply, type GameAction } from '../actions.ts';
import { tacticalAiStep } from '../ai/tacticalAi.ts';
import { hexDistance, parseKey } from '../hex.ts';
import { deserializeSave, serializeSave, validateGameState } from '../save.ts';
import { createGame, defaultSettings, setHolderPos, worldOf } from '../strategic.ts';
import { actionPoints, createBattle } from '../tactical.ts';
import type { Army, BattleUnit, GameState } from '../types.ts';
import { unitType } from '../units.ts';
import { campaignNodeEffects } from './campaign.ts';
import { campaignBuildingData, refreshCampaignNodeSnapshot } from './campaignNodes.ts';
import type { CampaignNodeSite } from './campaignNodes.ts';
import { quoteCampaignRazeTile } from './campaignRaze.ts';
import { createFoundationPlaytestConfiguration } from './playtestProfile.ts';
import type { FoundationCaptureBuilding } from './capture.ts';

interface Fixture {
  state: GameState;
  site: CampaignNodeSite;
  actorId: string;
  buildingId: string;
}
function holder(state: GameState, team: 'A' | 'B'): Army {
  return state.armies.find((army) => army.team === team && army.kind === 'commander')!;
}
function step(state: GameState, action: GameAction): GameState {
  const result = apply(state, action);
  expect(result.error, `${action.type}: ${result.error}`).toBeNull();
  expect(validateGameState(result.state), action.type).toEqual([]);
  return result.state;
}
function resume(state: GameState): GameState {
  const loaded = deserializeSave(serializeSave(state));
  if (!loaded.ok) throw new Error(loaded.error);
  expect(loaded.save.state).toEqual(state);
  return loaded.save.state;
}
function strategic(): { state: GameState; site: CampaignNodeSite; buildingId: string } {
  const profile = createFoundationPlaytestConfiguration(7, 3);
  const state = createGame({
    ...defaultSettings(),
    seed: 1,
    fog: false,
    grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
    controllers: { A: 'human', B: 'human' },
    battleObjective: { kind: 'capture_point', captureRadius: 0 },
    infrastructure: {
      ...profile,
      nodes: {
        ...profile.nodes,
        definitions: profile.nodes.definitions.map((d) =>
          d.id === 'workshop'
            ? {
                ...d,
                exclusiveUpgrades: [{ id: 'production', cpCost: 1, engineerRequired: false }],
                slotlessUnlocks: [{ id: 'archive', cpCost: 1, engineerRequired: false }],
              }
            : d,
        ),
      },
    },
  });
  const { world } = worldOf(state);
  const main = world.mains.find((main) => main.col === 1 && main.row === 1)!;
  const site = state.infrastructure!.sites.find((site) => site.mainHex === main.key)!;
  const node = state.infrastructure!.capture.nodes.find((node) => node.id === site.nodeId)!;
  const buildingId = `${site.nodeId}:acceptance-workshop`;
  // Explicit initial scenario assets, not earned construction or a granted battle outcome.
  Object.assign(node, {
    owner: 'B',
    buildings: [
      {
        ...node.buildings[0],
        data: { ...campaignBuildingData(node.buildings[0]), active: true, tier: 3 },
      },
      {
        id: buildingId,
        ruined: false,
        data: {
          definitionId: 'workshop',
          role: 'workshop',
          specialty: 'industrial',
          tier: 2,
          placement: 'annex',
          subHex: site.annexSubHexes[0],
          active: true,
          exclusiveChoices: ['production'],
          unlocks: ['archive'],
          equipmentIds: ['saved-kit'],
        },
      },
    ],
  });
  refreshCampaignNodeSnapshot(state);
  return { state, site, buildingId };
}
function fixture(stationed = false): Fixture {
  const { state, site, buildingId } = strategic();
  const { world } = worldOf(state);
  const attacker = holder(state, 'A');
  const defender = holder(state, 'B');
  const actorId = attacker.units[0].id;
  if (stationed) {
    const actor = attacker.units.shift()!;
    state.armies.push({
      id: 'prepared-guard',
      kind: 'garrison',
      building: 'temporary',
      team: 'A',
      pos: site.annexSubHexes[0],
      at: site.mainHex,
      units: [actor],
      movesLeft: 0,
      stationedFacing: 4,
    });
  }
  const battle = createBattle(state, attacker, defender, attacker.at, site.mainHex, world);
  const occupied = new Set([site.annexSubHexes[0], site.centerSubHex]);
  const cells = battle.mains
    .flatMap((main) => world.mainByKey.get(main)!.subKeys)
    .filter((key) => !occupied.has(key))
    .sort(
      (a, b) =>
        hexDistance(parseKey(b), parseKey(site.centerSubHex)) -
        hexDistance(parseKey(a), parseKey(site.centerSubHex)),
    );
  let centerAssigned = false;
  for (const unit of battle.units) {
    if (unit.id === actorId) unit.pos = site.annexSubHexes[0];
    else if (unit.team === 'A' && !centerAssigned) {
      unit.pos = site.centerSubHex;
      centerAssigned = true;
    } else unit.pos = cells.shift()!;
    unit.acted = false;
  }
  battle.phase = 'combat';
  battle.round = 1;
  battle.active = 'A';
  battle.forts[site.annexSubHexes[0]] = 1;
  state.forts[site.annexSubHexes[0]] = 1;
  state.phase = 'battle';
  state.battle = battle;
  refreshCampaignNodeSnapshot(state);
  expect(validateGameState(state)).toEqual([]);
  expect(quoteCampaignRazeTile(state, actorId, buildingId).eligible).toBe(true);
  return { state, site, actorId, buildingId };
}
function actor(f: Fixture, state = f.state): BattleUnit {
  return state.battle!.units.find((unit) => unit.id === f.actorId)!;
}
function building(f: Fixture, state = f.state): FoundationCaptureBuilding {
  return state
    .infrastructure!.capture.nodes.find((node) => node.id === f.site.nodeId)!
    .buildings.find((building) => building.id === f.buildingId)!;
}
function command(f: Fixture): GameAction {
  return { type: 'razeTile', unitId: f.actorId, buildingId: f.buildingId };
}
function reject(state: GameState, action: GameAction, error: string): void {
  const before = structuredClone(state);
  const result = apply(state, action);
  expect(result.error).toBe(error);
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
}
function finishWithNone(f: Fixture, state: GameState, retreat = false): GameState {
  if (retreat) {
    state = step(state, { type: 'endBattleTurn' });
    state = step(state, { type: 'retreat' });
  } else state = step(state, { type: 'secureObjective' });
  state = step(state, { type: 'concludeBattle' });
  const pending = state.infrastructure!.capture.pending!;
  expect(pending.event.kind).toBe('manual-battle-end');
  expect(pending.candidates.some((c) => c.node.id === f.site.nodeId)).toBe(true);
  const cp = { ...state.cp };
  for (const candidate of pending.candidates)
    state = step(state, { type: 'captureChoice', nodeId: candidate.node.id, outcome: 'none' });
  state = resume(state);
  state = step(state, { type: 'captureCommit' });
  if (state.infrastructure!.garrisons!.pendingStationing)
    state = step(state, { type: 'stationingCommit' });
  expect(state.cp).toEqual(cp);
  expect(state.phase).toBe('strategic');
  return state;
}

describe('selected tactical side-tile Raze canonical acceptance', () => {
  it('GAMES-ELEVATE-TACTICAL-TS-005: normal ACT, no CP or strategic work, one annex and immediate effects', () => {
    const f = fixture();
    const before = structuredClone(f.state);
    expect(
      campaignNodeEffects(f.state, f.site.nodeId).some(
        (effect) => effect.buildingId === f.buildingId,
      ),
    ).toBe(true);
    const state = step(f.state, command(f));
    expect(actor(f, state)).toMatchObject({ acted: true, mp: 0, pos: actor(f).pos });
    expect(actionPoints(actor(f, state)).left).toBe(0);
    expect(state.cp).toEqual(before.cp);
    expect(state.infrastructure!.capture.work).toMatchObject({
      commandPoints: before.infrastructure!.capture.work.commandPoints,
      nodeSpending: before.infrastructure!.capture.work.nodeSpending,
      engineerSpending: before.infrastructure!.capture.work.engineerSpending,
      receipts: before.infrastructure!.capture.work.receipts,
    });
    expect(state.battle!.ruinedInfrastructureBuildingIds).toEqual([f.buildingId]);
    expect(state.infrastructure!.capture.nodes).toEqual(before.infrastructure!.capture.nodes);
    expect(
      campaignNodeEffects(state, f.site.nodeId).some(
        (effect) => effect.buildingId === f.buildingId,
      ),
    ).toBe(false);
  });
  it('GAMES-ELEVATE-TACTICAL-TS-006: stationed non-engineer razes in place without movement, capture or new-fort authority', () => {
    const f = fixture(true);
    expect(actor(f)).toMatchObject({
      stationed: true,
      mp: 0,
      facing: 4,
      typeId: 'ww2_rifle_infantry',
    });
    const neighbor = worldOf(f.state)
      .world.mainByKey.get(f.site.mainHex)!
      .subKeys.find((key) => !f.state.battle!.units.some((unit) => unit.pos === key))!;
    reject(
      f.state,
      { type: 'move', unitId: f.actorId, cell: neighbor },
      'Stationed garrisons may only fire in battle',
    );
    reject(
      f.state,
      { type: 'rotate', unitId: f.actorId, dir: 1 },
      'Stationed garrisons may only fire in battle',
    );
    reject(
      f.state,
      { type: 'captureTile', unitId: f.actorId, buildingId: f.buildingId } as unknown as GameAction,
      'Unknown action',
    );
    const mobile = f.state.battle!.units.find(
      (unit) => unit.team === 'A' && !unit.stationed && unit.typeId === 'ww2_rifle_infantry',
    )!;
    reject(f.state, { type: 'dig', unitId: mobile.id }, 'Only engineers can dig in');
    const engineer = f.state.battle!.units.find(
      (unit) => unit.team === 'A' && unit.typeId === 'ww2_engineer',
    )!;
    expect(apply(f.state, { type: 'dig', unitId: engineer.id }).error).toBeNull();
    const strategy = strategic().state;
    expect(apply(strategy, { type: 'fortify', hex: strategy.hq.A }).error).toBeNull();
    for (const army of strategy.armies.filter((army) => army.team === 'A'))
      army.units = army.units.filter((unit) => !unitType(unit.typeId).engineer);
    refreshCampaignNodeSnapshot(strategy);
    reject(
      strategy,
      { type: 'fortify', hex: strategy.hq.A },
      'A living friendly engineer is required to build new forts',
    );
    const state = step(f.state, command(f));
    expect(actor(f, state)).toMatchObject({
      stationed: true,
      acted: true,
      mp: 0,
      pos: actor(f).pos,
      facing: 4,
    });
  });
  it('GAMES-ELEVATE-TACTICAL-TS-007: forbidden Tile scopes reject specifically; paid Node choices retain turn-start MainHex exception', () => {
    for (const kind of [
      'center',
      'adjacent',
      'friendly',
      'neutral',
      'road',
      'fort',
      'capture',
    ] as const) {
      const f = fixture();
      const node = f.state.infrastructure!.capture.nodes.find((node) => node.id === f.site.nodeId)!;
      let request = command(f);
      let message = '';
      if (kind === 'center') {
        request = { type: 'razeTile', unitId: f.actorId, buildingId: node.buildings[0].id };
        message = 'Only an annex tile can be razed with this action';
      }
      if (kind === 'adjacent') {
        actor(f).pos = f.site.annexSubHexes[1];
        message = 'Stand on the annex tile to raze it';
      }
      if (kind === 'friendly' || kind === 'neutral') {
        Object.assign(node, { owner: kind === 'friendly' ? 'A' : null });
        message = 'Raze Tile requires an enemy annex';
      }
      if (kind === 'road' || kind === 'fort') {
        request = { type: 'razeTile', unitId: f.actorId, buildingId: kind };
        message = 'Unknown annex building';
      }
      if (kind === 'capture') {
        request = {
          type: 'captureTile',
          unitId: f.actorId,
          buildingId: f.buildingId,
        } as unknown as GameAction;
        message = 'Unknown action';
      }
      expect(actor(f).acted).toBe(false);
      reject(f.state, request, message);
    }
    const f = strategic();
    const world = worldOf(f.state).world;
    setHolderPos(world, holder(f.state, 'A'), f.site.annexSubHexes[1]);
    refreshCampaignNodeSnapshot(f.state);
    const state = step(step(f.state, { type: 'endTurn' }), { type: 'endTurn' });
    expect(holder(state, 'A').pos).not.toBe(f.site.centerSubHex);
    expect(state.infrastructure!.capture.pending!.costs).toEqual({ capture: 7, raze: 3 });
    expect(
      state.infrastructure!.capture.pending!.candidates.some((c) => c.node.id === f.site.nodeId),
    ).toBe(true);
    for (const [outcome, cost] of [
      ['capture', 7],
      ['raze', 3],
    ] as const) {
      let variant = structuredClone(state);
      const cp = variant.cp.A;
      variant = step(variant, { type: 'captureChoice', nodeId: f.site.nodeId, outcome });
      variant = step(variant, { type: 'captureCommit' });
      expect(variant.cp.A).toBe(cp - cost);
      expect(
        variant.infrastructure!.capture.nodes.find((node) => node.id === f.site.nodeId)!.owner,
      ).toBe(outcome === 'capture' ? 'A' : null);
    }
  });
  it('GAMES-ELEVATE-TACTICAL-TS-008: exact tactical save preserves ACT, movement, ruin, fort and pending commit without replay', () => {
    const f = fixture();
    let state = step(f.state, command(f));
    state = resume(state);
    expect(actor(f, state)).toMatchObject({ acted: true, mp: 0 });
    expect(state.forts).toEqual(f.state.forts);
    expect(state.battle!.forts).toEqual(f.state.battle!.forts);
    expect(state.cp).toEqual(f.state.cp);
    state = step(state, { type: 'secureObjective' });
    state = step(state, { type: 'concludeBattle' });
    const pending = resume(state);
    expect(pending.infrastructure!.clock).toEqual(state.infrastructure!.clock);
    expect(pending.infrastructure!.capture.pending).toEqual(state.infrastructure!.capture.pending);
    expect(pending.infrastructure!.garrisons).toEqual(state.infrastructure!.garrisons);
    expect(pending.forts[f.site.annexSubHexes[0]]).toBe(1);
    expect(pending.infrastructure!.clock!.paidIncomeEvents).toEqual(
      f.state.infrastructure!.clock!.paidIncomeEvents,
    );
  });
  it('GAMES-ELEVATE-TACTICAL-TS-009: tier/upgrades/unlocks/equipment survive a real manual commit and Do nothing', () => {
    const f = fixture();
    const data = structuredClone(building(f).data);
    const other = structuredClone(f.state.infrastructure!.capture.nodes);
    const state = finishWithNone(f, step(f.state, command(f)));
    expect(building(f, state)).toEqual({ id: f.buildingId, ruined: true, data });
    expect(campaignBuildingData(building(f, state))).toMatchObject({
      tier: 2,
      exclusiveChoices: ['production'],
      unlocks: ['archive'],
      equipmentIds: ['saved-kit'],
    });
    expect(
      state.infrastructure!.capture.nodes.find((node) => node.id === f.site.nodeId)!.owner,
    ).toBe('B');
    expect(
      state
        .infrastructure!.capture.nodes.flatMap((node) => node.buildings)
        .filter((building) => building.id !== f.buildingId),
    ).toEqual(
      other.flatMap((node) => node.buildings).filter((building) => building.id !== f.buildingId),
    );
    expect(
      campaignNodeEffects(state, f.site.nodeId).some(
        (effect) => effect.buildingId === f.buildingId,
      ),
    ).toBe(false);
    expect(resume(state)).toEqual(state);
  });
  it('GAMES-ELEVATE-TACTICAL-TS-010: specific illegal/stale requests are atomic and replay cannot spend or damage twice', () => {
    for (const kind of ['spent', 'dead', 'ruined', 'wrong-team', 'missing'] as const) {
      const f = fixture();
      let message = '';
      if (kind === 'spent') {
        actor(f).acted = true;
        message = 'Unit already acted';
      }
      if (kind === 'dead') {
        actor(f).hp = 0;
        message = 'A living military unit must be on the field';
      }
      if (kind === 'ruined') {
        Object.assign(building(f), { ruined: true });
        message = 'Annex is already ruined';
      }
      if (kind === 'wrong-team') {
        f.state.battle!.active = 'B';
        message = 'Not your unit';
      }
      if (kind === 'missing') {
        actor(f).pos = null;
        message = 'A living military unit must be on the field';
      }
      reject(f.state, command(f), message);
    }
    const f = fixture();
    const state = step(f.state, command(f));
    reject(state, command(f), 'Unit already acted');
    const later = structuredClone(state);
    actor(f, later).acted = false;
    reject(later, command(f), 'Annex is already ruined');
    expect(later.cp).toEqual(f.state.cp);
    expect(later.infrastructure!.capture.work).toMatchObject({
      commandPoints: f.state.infrastructure!.capture.work.commandPoints,
      nodeSpending: f.state.infrastructure!.capture.work.nodeSpending,
      engineerSpending: f.state.infrastructure!.capture.work.engineerSpending,
      receipts: f.state.infrastructure!.capture.work.receipts,
    });
  });
  it('GAMES-ELEVATE-TACTICAL-TS-011: human and AI share Raze legality, reload and final ruin without enabling Capture Tile', () => {
    const f = fixture(true);
    const ai = structuredClone(f.state);
    // The prepared scenario uses an alternate valid capture point so the AI has not already
    // won by holding the node center and therefore considers the annex action.
    ai.battle!.objective.captureKey = worldOf(ai)
      .world.mainByKey.get(ai.battle!.origin)!
      .subKeys.find(
        (key) => !ai.battle!.units.some((unit) => unit.team === 'A' && unit.pos === key),
      )!;
    for (const unit of ai.battle!.units)
      if (unit.team === 'A' && unit.id !== f.actorId) unit.acted = true;
    // Only the guard has an unused ACT; opponents are outside its weapon range in this prepared position.
    const world = worldOf(ai).world;
    const positions = ai
      .battle!.mains.flatMap((main) => world.mainByKey.get(main)!.subKeys)
      .filter(
        (key) =>
          hexDistance(parseKey(key), parseKey(actor(f, ai).pos!)) > 6 &&
          !ai.battle!.units.some((unit) => unit.team === 'A' && unit.pos === key),
      );
    for (const unit of ai.battle!.units.filter((unit) => unit.team === 'B'))
      unit.pos = positions.shift()!;
    const aiAction = tacticalAiStep(ai);
    expect(aiAction).toEqual(command(f));
    const viaAi = step(ai, aiAction);
    const viaHuman = step(ai, command(f));
    expect(viaAi).toEqual(viaHuman);
    expect(resume(viaAi)).toEqual(viaHuman);
    const state = finishWithNone(f, resume(viaAi), true);
    const humanFinal = finishWithNone(f, resume(viaHuman), true);
    expect(state).toEqual(humanFinal);
    expect(building(f, state).ruined).toBe(true);
    expect(
      state.infrastructure!.capture.nodes.find((node) => node.id === f.site.nodeId)!.owner,
    ).toBe('B');
    reject(
      f.state,
      { type: 'captureTile', unitId: f.actorId, buildingId: f.buildingId } as unknown as GameAction,
      'Unknown action',
    );
  });
});
