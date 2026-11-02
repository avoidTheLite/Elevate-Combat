// Scoped central-boundary regressions, not a claim that all foundation scenarios are executed.
import { describe, expect, it } from 'vitest';
import { apply } from '../actions.ts';
import type { GameAction } from '../actions.ts';
import { commanderReach } from '../command.ts';
import { hexDistance, parseKey } from '../hex.ts';
import { deserializeSave, serializeSave, validateGameState } from '../save.ts';
import { createGame, defaultSettings, makeUnit, setHolderPos, worldOf } from '../strategic.ts';
import type { Army, GameState, Team } from '../types.ts';
import { unitType } from '../units.ts';
import { campaignIncome, campaignSupplyView } from './campaign.ts';
import { constructCampaignNodeRequest, refreshCampaignNodeSnapshot } from './campaignNodes.ts';
import type { CampaignNodeActionInput, CampaignNodeSite } from './campaignNodes.ts';
import { createFoundationPlaytestConfiguration } from './playtestProfile.ts';
import { quoteCampaignRecruitment } from './campaignRecruitment.ts';

function game(): GameState {
  const state = createGame({
    ...defaultSettings(),
    seed: 1,
    fog: false,
    controllers: { A: 'human', B: 'human' },
    grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
    infrastructure: createFoundationPlaytestConfiguration(7, 3),
  });
  state.cp = { A: 100, B: 100 };
  refreshCampaignNodeSnapshot(state);
  return state;
}
function commander(state: GameState, team: Team): Army {
  return state.armies.find((holder) => holder.kind === 'commander' && holder.team === team)!;
}
function step(state: GameState, action: GameAction): GameState {
  const result = apply(state, action);
  expect(result.error, `${action.type}: ${result.error}`).toBeNull();
  expect(validateGameState(result.state), `saved shape after ${action.type}`).toEqual([]);
  return result.state;
}
function resume(state: GameState): GameState {
  expect(validateGameState(state)).toEqual([]);
  const loaded = deserializeSave(
    serializeSave(state, 'Foundation phase regression', '2026-10-31T12:00:00.000Z'),
  );
  if (!loaded.ok) throw new Error(loaded.error);
  expect(loaded.save.state).toEqual(state);
  return loaded.save.state;
}
function nodeWork(state: GameState, input: CampaignNodeActionInput): GameState {
  return step(state, { type: 'nodeWork', request: constructCampaignNodeRequest(state, input) });
}
function citySite(state: GameState): CampaignNodeSite {
  const { world } = worldOf(state);
  const key = world.mains.find((main) => main.col === 1 && main.row === 1)!.key;
  return state.infrastructure!.sites.find((site) => site.mainHex === key)!;
}

/** Actual B-turn activation and movement; only initial holder positioning/resources are fixtures. */
function activateEnemyCity(holdAInside: boolean): { state: GameState; site: CampaignNodeSite } {
  let state = game();
  const site = citySite(state);
  const { world } = worldOf(state);
  const ordered = (home: string): string[] =>
    [...site.annexSubHexes].sort(
      (a, b) =>
        hexDistance(parseKey(a), world.mainByKey.get(home)!.center) -
        hexDistance(parseKey(b), world.mainByKey.get(home)!.center),
    );
  if (holdAInside) setHolderPos(world, commander(state, 'A'), ordered(state.hq.A)[0]);
  setHolderPos(world, commander(state, 'B'), ordered(state.hq.B)[0]);
  refreshCampaignNodeSnapshot(state);
  state = step(state, { type: 'endTurn' });
  expect(state.active).toBe('B');
  state = nodeWork(state, {
    kind: 'activate',
    nodeId: site.nodeId,
    commanderId: commander(state, 'B').id,
    centerDefinitionId: 'generic',
  });
  expect(state.infrastructure!.capture.nodes.find((node) => node.id === site.nodeId)!.owner).toBe(
    'B',
  );
  const b = commander(state, 'B');
  const homeCenter = state.infrastructure!.sites.find(
    (candidate) => candidate.homeTeam === 'B',
  )!.centerSubHex;
  const destination = [...commanderReach(state, b)]
    .filter(
      ([key, distance]) =>
        distance > 0 && world.subByKey.get(key)!.main === state.hq.B && key !== homeCenter,
    )
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]?.[0];
  expect(destination).toBeDefined();
  state = step(state, { type: 'moveCommander', armyId: b.id, dest: destination! });
  expect(commander(state, 'B').at).not.toBe(site.mainHex);
  return { state, site };
}

function chooseAndCommit(
  state: GameState,
  nodeId: string,
  outcome: 'capture' | 'raze' | 'none',
): GameState {
  state = step(state, { type: 'captureChoice', nodeId, outcome });
  state = resume(state);
  return step(state, { type: 'captureCommit' });
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-001: central acquisition windows and saved progress', () => {
  // Supports TS-037/039/048: actual early acquisition and work cap, not other engineer behaviors.
  it('captures a real B-activated city after A income, granting two building operations without a new payment or deployment', () => {
    const setup = activateEnemyCity(true);
    let state = setup.state;
    const site = setup.site;
    const oldBWork = structuredClone(
      state.infrastructure!.capture.work.nodeSpending.find(
        (spend) => spend.nodeId === site.nodeId && spend.team === 'B',
      ),
    );
    const openingCp = state.cp.A;
    const payment = campaignIncome(state, 'A');
    state = step(state, { type: 'endTurn' });
    expect(state.active).toBe('A');
    expect(state.turn).toBe(2);
    expect(state.cp.A).toBe(openingCp + payment);
    expect(state.infrastructure!.capture.pending?.event.kind).toBe('turn-start-after-income');
    expect(
      state.infrastructure!.capture.pending!.candidates.map((candidate) => candidate.node.id),
    ).toContain(site.nodeId);
    const incomeEvents = [...state.infrastructure!.clock!.paidIncomeEvents];
    state = resume(state);
    state = chooseAndCommit(state, site.nodeId, 'capture');
    expect(state.cp.A).toBe(openingCp + payment - 7);
    expect(state.infrastructure!.clock!.paidIncomeEvents).toEqual(incomeEvents);
    const spend = state.infrastructure!.capture.work.nodeSpending.find(
      (s) => s.nodeId === site.nodeId && s.team === 'A',
    )!;
    expect(spend).toMatchObject({
      ordinarySpent: false,
      operationCount: 0,
      buildingWindow: 'open',
    });
    expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry', site.nodeId)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('next owner turn'),
    });
    const engineer = commander(state, 'A').units.find((unit) => unitType(unit.typeId).engineer)!;
    expect(engineer).toBeDefined();
    state = nodeWork(state, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'workshop',
      subHex: site.annexSubHexes[1],
      tier: 1,
      engineerUnitId: null,
    });
    state = resume(state);
    state = nodeWork(state, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'barracks',
      subHex: site.annexSubHexes[2],
      tier: 1,
      engineerUnitId: engineer.id,
    });
    expect(state.cp.A).toBe(openingCp + payment - 7 - 3 - 3);
    expect(state.infrastructure!.capture.work.nodeSpending).toContainEqual(oldBWork);
    expect(
      state.infrastructure!.capture.work.nodeSpending.find(
        (s) => s.nodeId === site.nodeId && s.team === 'A',
      ),
    ).toMatchObject({ operationCount: 2 });
    state = resume(state);
    const before = structuredClone(state);
    const third = apply(state, {
      type: 'nodeWork',
      request: constructCampaignNodeRequest(state, {
        kind: 'build',
        nodeId: site.nodeId,
        definitionId: 'tower',
        subHex: site.annexSubHexes[3],
        tier: 1,
        engineerUnitId: engineer.id,
      }),
    });
    expect(third.error).toContain('two operations');
    expect(third.state).toEqual(before);
    expect(state.infrastructure!.clock!.paidIncomeEvents).toEqual(incomeEvents);
  });

  // Supports TS-049/027: late positional acquisition and persisted closure; not all supply routes.
  it('captures through a real later move, closing work/deployment until the next legitimate owner turn', () => {
    const setup = activateEnemyCity(false);
    let state = setup.state;
    const site = setup.site;
    state = step(state, { type: 'endTurn' });
    expect(state.infrastructure!.capture.pending).toBeNull();
    const sourceSupply = campaignSupplyView(state, 'A')!;
    expect(sourceSupply.nodes[site.nodeId].connection).toBe('none');
    const army = commander(state, 'A');
    expect(army.pos).not.toBe(site.centerSubHex);
    expect(commanderReach(state, army).has(site.centerSubHex)).toBe(true);
    const incomeCp = state.cp.A;
    const paid = [...state.infrastructure!.clock!.paidIncomeEvents];
    state = step(state, { type: 'moveCommander', armyId: army.id, dest: site.centerSubHex });
    expect(state.infrastructure!.capture.pending?.event.kind).toBe('strategic-movement');
    state = chooseAndCommit(state, site.nodeId, 'capture');
    expect(state.cp.A).toBe(incomeCp - 7);
    expect(state.infrastructure!.clock!.paidIncomeEvents).toEqual(paid);
    expect(campaignSupplyView(state, 'A')!.nodes[site.nodeId].connection).not.toBe('none');
    expect(
      state.infrastructure!.capture.work.nodeSpending.find(
        (s) => s.nodeId === site.nodeId && s.team === 'A',
      ),
    ).toMatchObject({ buildingWindow: 'closed', operationCount: 0, ordinarySpent: false });
    state = resume(state);
    const closedWork = structuredClone(
      state.infrastructure!.capture.work.nodeSpending.find(
        (s) => s.nodeId === site.nodeId && s.team === 'A',
      ),
    );
    const request = constructCampaignNodeRequest(state, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'workshop',
      subHex: site.annexSubHexes[1],
      tier: 1,
      engineerUnitId: null,
    });
    const blocked = apply(state, { type: 'nodeWork', request });
    expect(blocked.error).toContain('building window');
    expect(blocked.state).toBe(state);
    expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry', site.nodeId).allowed).toBe(false);
    const afterCapture = state.cp.A;
    const mobile = commander(state, 'A');
    const leaveCenter = site.annexSubHexes.find((key) => commanderReach(state, mobile).has(key))!;
    expect(leaveCenter).toBeDefined();
    state = step(state, { type: 'moveCommander', armyId: mobile.id, dest: leaveCenter });
    state = step(state, { type: 'endTurn' });
    state = step(state, { type: 'endTurn' });
    expect(state.active).toBe('A');
    expect(state.turn).toBe(3);
    expect(state.cp.A).toBe(afterCapture + campaignIncome(state, 'A'));
    expect(state.infrastructure!.capture.work.nodeSpending).toContainEqual(closedWork);
    expect(quoteCampaignRecruitment(state, 'ww2_rifle_infantry', site.nodeId).allowed).toBe(true);
    state = nodeWork(state, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'workshop',
      subHex: site.annexSubHexes[1],
      tier: 1,
      engineerUnitId: null,
    });
    state = step(state, { type: 'recruit', nodeId: site.nodeId, typeId: 'ww2_rifle_infantry' });
    expect(
      state.armies.some(
        (holder) =>
          holder.building === 'node' && holder.nodeId === site.nodeId && holder.units.length === 1,
      ),
    ).toBe(true);
    resume(state);
  });
});

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: central battle outcomes and exact resume', () => {
  // Supports TS-047: this is one auto-resolve cleanup/outcome boundary, not all odds or damage.
  it('removes a killed temporary guard after real auto-resolve without granting capture', () => {
    let state = game();
    const { world } = worldOf(state);
    const bHome = world.mainByKey.get(state.hq.B)!;
    const pos = bHome.subKeys.find(
      (key) => (state.forts[key] ?? 0) > 0 && !state.armies.some((holder) => holder.pos === key),
    )!;
    expect(pos).toBeDefined();
    const guard: Army = {
      id: 'wounded-auto-guard',
      team: 'B',
      kind: 'garrison',
      building: 'temporary',
      at: bHome.key,
      pos,
      movesLeft: 0,
      units: [{ ...makeUnit(state, 'B', 'ww2_rifle_infantry'), hp: 0.1 }],
    };
    state.armies.push(guard);
    const attacker = commander(state, 'A');
    const near = world.subs.find(
      (cell) =>
        hexDistance(cell.hex, parseKey(pos)) === 1 &&
        !state.armies.some((holder) => holder.pos === cell.key),
    )!.key;
    setHolderPos(world, attacker, near);
    state.rng = 1;
    refreshCampaignNodeSnapshot(state);
    const owners = state.infrastructure!.capture.nodes.map((node) => node.owner);
    state = step(state, { type: 'engage', armyId: attacker.id, targetId: guard.id });
    state = step(state, { type: 'autoResolve' });
    expect(state.armies.some((holder) => holder.id === guard.id)).toBe(false);
    expect(
      state.armies.some((holder) => holder.building === 'temporary' && holder.units.length === 0),
    ).toBe(false);
    expect(state.infrastructure!.capture.receipts).toEqual([]);
    expect(state.infrastructure!.capture.pending).toBeNull();
    expect(state.infrastructure!.capture.nodes.map((node) => node.owner)).toEqual(owners);
    resume(state);
  });

  function manualBattle(): { state: GameState; site: CampaignNodeSite } {
    const setup = activateEnemyCity(false);
    let state = step(setup.state, { type: 'endTurn' });
    const { world } = worldOf(state);
    const site = setup.site;
    const a = commander(state, 'A');
    const b = commander(state, 'B');
    setHolderPos(world, a, site.annexSubHexes[0]);
    setHolderPos(world, b, site.annexSubHexes[3]);
    refreshCampaignNodeSnapshot(state);
    state = step(state, { type: 'engage', armyId: a.id, targetId: b.id });
    state = step(state, { type: 'startBattle' });
    state = step(state, { type: 'finishDeploy' });
    state = step(state, { type: 'finishDeploy' });
    expect(state.battle!.phase).toBe('combat');
    const battle = state.battle!;
    const attacker = battle.units.find((unit) => unit.team === 'A')!;
    const occupied = new Set([site.centerSubHex]);
    attacker.pos = site.centerSubHex;
    const cells = battle.mains
      .flatMap((key) => world.mainByKey.get(key)!.subKeys)
      .filter(
        (key) =>
          !(battle.forts[key] ?? 0) &&
          key !== site.centerSubHex &&
          hexDistance(parseKey(key), parseKey(site.centerSubHex)) >
            battle.objective.captureRadius &&
          !state.infrastructure!.sites.some((candidate) => candidate.centerSubHex === key),
      );
    let cursor = 0;
    for (const unit of battle.units)
      if (unit.id !== attacker.id) {
        while (occupied.has(cells[cursor])) cursor++;
        unit.pos = cells[cursor++];
        occupied.add(unit.pos);
      }
    return { state, site };
  }

  it.each([null, 'B'] as const)(
    'uses actual final center evidence when manual winner is %s, without automatic stationing',
    (winner) => {
      const setup = manualBattle();
      let state = setup.state;
      const site = setup.site;
      state.battle!.phase = 'over';
      state.battle!.winner = winner;
      state.battle!.endReason = 'Synthetic final-state boundary';
      state = step(state, { type: 'concludeBattle' });
      expect(
        state.infrastructure!.capture.pending!.candidates.map((candidate) => candidate.node.id),
      ).toEqual([site.nodeId]);
      expect(state.infrastructure!.garrisons!.pendingStationing).toBeNull();
      expect(state.armies.some((holder) => holder.building === 'temporary')).toBe(false);
      expect(state.winner).toBeNull();
      state = resume(state);
      state = chooseAndCommit(state, site.nodeId, 'none');
      expect(
        state.infrastructure!.capture.nodes.find((node) => node.id === site.nodeId)!.owner,
      ).toBe('B');
      expect(state.winner).toBeNull();
      expect(state.phase).toBe('strategic');
      resume(state);
    },
  );

  it('preserves EXTRACT mobile return to the real battle origin after saved manual choices', () => {
    const setup = manualBattle();
    let state = setup.state;
    const site = setup.site;
    const armyId = state.battle!.attackerArmyId;
    const origin = state.battle!.origin;
    state = step(state, { type: 'extract' });
    expect(state.battle!.extracted).toBe(true);
    state = step(state, { type: 'concludeBattle' });
    state = resume(state);
    if (state.infrastructure!.capture.pending) state = chooseAndCommit(state, site.nodeId, 'none');
    if (state.infrastructure!.garrisons!.pendingStationing)
      state = step(state, { type: 'stationingCommit' });
    expect(state.phase).toBe('strategic');
    expect(state.battle).toBeNull();
    expect(state.armies.find((holder) => holder.id === armyId)!.at).toBe(origin);
    expect(state.armies.find((holder) => holder.id === armyId)!.movesLeft).toBe(0);
    expect(state.armies.some((holder) => holder.building === 'temporary')).toBe(false);
    resume(state);
  });
});
