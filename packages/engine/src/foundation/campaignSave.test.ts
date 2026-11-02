import { describe, expect, it } from 'vitest';
import { apply } from '../actions.ts';
import { buildWorld } from '../grid.ts';
import { hexKey, neighbors } from '../hex.ts';
import {
  SAVE_FORMAT,
  SAVE_SCHEMA,
  deserializeSave,
  migrateSave,
  serializeSave,
  validateGameState,
} from '../save.ts';
import { createGame, defaultSettings, makeUnit, worldOf } from '../strategic.ts';
import { createBattle } from '../tactical.ts';
import type { Army, GameState } from '../types.ts';
import { createFoundationPlaytestConfiguration } from './playtestProfile.ts';
import { constructCampaignNodeRequest, refreshCampaignNodeSnapshot } from './campaignNodes.ts';
import { campaignGarrisonTargetOptions } from './campaignGarrisons.ts';
import { validateCampaignConfiguration } from './campaign.ts';
import type { CampaignConfiguration } from './campaign.ts';

const SAVED_AT = '2026-10-31T12:34:56.000Z';

function legacyGame(): GameState {
  const settings = {
    ...defaultSettings(),
    grid: { mainCols: 4, mainRows: 3, subRadius: 2 },
    controllers: { A: 'human' as const, B: 'human' as const },
  };
  delete settings.infrastructure;
  return createGame(settings);
}

function schemaTwo(state: GameState): string {
  return JSON.stringify({
    format: SAVE_FORMAT,
    schema: 2,
    engineVersion: '1.0.0-before-foundations',
    savedAt: SAVED_AT,
    label: 'Saved turn in progress',
    state,
  });
}

function configuredGame(): GameState {
  const state = createGame({
    ...defaultSettings(),
    grid: { mainCols: 4, mainRows: 3, subRadius: 2 },
    infrastructure: createFoundationPlaytestConfiguration(7, 3),
  });
  expect(state.infrastructure).toBeDefined();
  return state;
}

function reverseObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseObjectKeys) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseObjectKeys(child)]),
    ) as T;
  return value;
}

function configuredWith(configuration: CampaignConfiguration): GameState {
  return createGame({
    ...defaultSettings(),
    grid: { mainCols: 4, mainRows: 3, subRadius: 2 },
    infrastructure: configuration,
  });
}

function resumed(state: GameState, text = serializeSave(state, 'Round trip', SAVED_AT)): GameState {
  expect(validateGameState(state)).toEqual([]);
  const before = JSON.stringify(state);
  const loaded = deserializeSave(text);
  if (!loaded.ok) throw new Error(loaded.error);
  expect(loaded.save.schema).toBe(SAVE_SCHEMA);
  expect(loaded.save.state).toEqual(state);
  expect(JSON.stringify(state)).toBe(before);
  return loaded.save.state;
}

function battleGame(temporary = false): GameState {
  const state = legacyGame();
  const { world } = worldOf(state);
  const attacker = state.armies.find(
    (holder) => holder.kind === 'commander' && holder.team === 'A',
  )!;
  const defender = state.armies.find(
    (holder) => holder.kind === 'commander' && holder.team === 'B',
  )!;
  if (temporary) {
    const cell = world.mainByKey
      .get(defender.at)!
      .subKeys.find(
        (key) => !state.armies.some((holder) => holder.pos === key) && !state.forts[key],
      )!;
    state.armies.push({
      id: 'saved-temporary-guard',
      kind: 'garrison',
      building: 'temporary',
      team: 'A',
      at: defender.at,
      pos: cell,
      movesLeft: 0,
      units: [makeUnit(state, 'A', 'ww2_rifle_infantry')],
    });
  }
  const battle = createBattle(state, attacker, defender, attacker.at, defender.at, world);
  const occupied = new Set(battle.units.filter((unit) => unit.stationed).map((unit) => unit.pos));
  const cells = battle.mains.flatMap((key) => world.mainByKey.get(key)!.subKeys);
  let cursor = 0;
  for (const unit of battle.units) {
    if (unit.stationed) continue;
    while (occupied.has(cells[cursor])) cursor += 1;
    unit.pos = cells[cursor++];
    occupied.add(unit.pos);
  }
  battle.phase = 'combat';
  battle.round = 4;
  battle.active = 'B';
  battle.units[0].mp = 1;
  battle.units[0].moved = true;
  battle.units[0].movedDist = 2;
  battle.units[0].acted = true;
  battle.units[0].suppressed = true;
  battle.units[0].exposed = true;
  battle.units[0].firstStrikeUsed = true;
  const guard = battle.units.find((unit) => unit.stationed);
  if (guard) {
    guard.acted = true;
    guard.suppressed = true;
  }
  state.phase = 'battle';
  state.pending = null;
  state.battle = battle;
  state.turn = 7;
  state.active = 'A';
  state.cp = { A: 17, B: 4 };
  state.rng = 0xfedcba98;
  return state;
}

function pendingManualCapture(): GameState {
  const state = configuredGame();
  const { world } = worldOf(state);
  const attacker = state.armies.find(
    (holder) => holder.kind === 'commander' && holder.team === 'A',
  )!;
  const defender = state.armies.find(
    (holder) => holder.kind === 'commander' && holder.team === 'B',
  )!;
  const battle = createBattle(state, attacker, defender, attacker.at, defender.at, world);
  const site = state.infrastructure!.sites.find((candidate) => candidate.homeTeam === 'B')!;
  const positions = world.mainByKey
    .get(site.mainHex)!
    .subKeys.filter((key) => key !== site.centerSubHex);
  let cursor = 0;
  for (const unit of battle.units) {
    unit.pos = positions[cursor++];
    if (unit.team === 'B') unit.hp = 0;
  }
  battle.units.find((unit) => unit.team === 'A')!.pos = site.centerSubHex;
  battle.phase = 'over';
  battle.round = 3;
  battle.winner = 'A';
  battle.endReason = 'Fixture: garrison cleared and attacker holds center';
  state.phase = 'battle';
  state.battle = battle;
  state.pending = null;
  state.cp.A = 0;
  refreshCampaignNodeSnapshot(state);
  const concluded = apply(state, { type: 'concludeBattle' });
  if (concluded.error) throw new Error(concluded.error);
  expect(concluded.state.infrastructure!.capture.pending).not.toBeNull();
  expect(concluded.state.armies.some((holder) => holder.id === defender.id)).toBe(false);
  return concluded.state;
}

function battleWithAnnex(inBattle = true): {
  state: GameState;
  buildingId: string;
  nodeId: string;
} {
  const original = configuredGame();
  const site = original.infrastructure!.sites.find((candidate) => candidate.homeTeam === 'A')!;
  const built = apply(original, {
    type: 'nodeWork',
    request: constructCampaignNodeRequest(original, {
      kind: 'build',
      nodeId: site.nodeId,
      definitionId: 'workshop',
      subHex: site.annexSubHexes[0],
      tier: 1,
      engineerUnitId: null,
    }),
  });
  if (built.error) throw new Error(built.error);
  const state = built.state;
  const world = worldOf(state).world;
  const a = state.armies.find((holder) => holder.kind === 'commander' && holder.team === 'A')!;
  const b = state.armies.find((holder) => holder.kind === 'commander' && holder.team === 'B')!;
  const battle = inBattle
    ? createBattle(state, b, a, b.at, a.at, world)
    : createBattle(state, a, b, a.at, b.at, world);
  const cells = battle.mains.flatMap((key) => world.mainByKey.get(key)!.subKeys);
  battle.units.forEach((unit, index) => {
    unit.pos = cells[index];
  });
  battle.phase = 'combat';
  battle.round = 2;
  state.phase = 'battle';
  state.battle = battle;
  state.pending = null;
  const buildingId = state
    .infrastructure!.capture.nodes.find((node) => node.id === site.nodeId)!
    .buildings.find((building) => building.id !== `${site.nodeId}:center`)!.id;
  expect(battle.mains.includes(site.mainHex)).toBe(inBattle);
  return { state, buildingId, nodeId: site.nodeId };
}

function retreatingGarrison(mode: 'regular' | 'mobile' = 'regular'): {
  state: GameState;
  nodeId: string;
  garrisonId: string;
  lostUnitIds: string[];
  guardId: string;
} {
  const state = configuredGame();
  const world = worldOf(state).world;
  const site = state.infrastructure!.sites.find((candidate) => candidate.homeTeam === 'B')!;
  const attacker = state.armies.find(
    (holder) => holder.kind === 'commander' && holder.team === 'A',
  )!;
  const garrison = state.armies.find(
    (holder) =>
      holder.team === 'B' &&
      (mode === 'regular' ? holder.building === 'hq' : holder.kind === 'commander'),
  )!;
  if (mode === 'regular')
    garrison.units.push(
      makeUnit(state, 'B', 'ww2_rifle_infantry'),
      makeUnit(state, 'B', 'ww2_mortar'),
    );
  const guardPosition = site.annexSubHexes.find(
    (key) => !state.armies.some((holder) => holder.pos === key),
  )!;
  const guard: Army = {
    id: 'withdrawal-stationed-guard',
    team: 'B',
    kind: 'garrison',
    building: 'temporary',
    pos: guardPosition,
    at: site.mainHex,
    movesLeft: 0,
    stationedFacing: 4,
    units: [makeUnit(state, 'B', 'ww2_rifle_infantry')],
  };
  state.armies.push(guard);
  const battle = createBattle(state, attacker, garrison, attacker.at, site.mainHex, world);
  const cells = battle.mains
    .flatMap((key) => world.mainByKey.get(key)!.subKeys)
    .filter((key) => key !== site.centerSubHex && key !== guard.pos);
  let cursor = 0;
  for (const unit of battle.units) if (!unit.stationed) unit.pos = cells[cursor++];
  battle.units.find((unit) => unit.team === 'A')!.pos = site.centerSubHex;
  battle.phase = 'combat';
  battle.active = 'B';
  battle.round = 4;
  state.phase = 'battle';
  state.battle = battle;
  state.pending = null;
  refreshCampaignNodeSnapshot(state);
  return {
    state,
    nodeId: site.nodeId,
    garrisonId: garrison.id,
    lostUnitIds: garrison.units.map((unit) => unit.id),
    guardId: guard.id,
  };
}

function pendingGarrisonRetreat(
  mode: 'regular' | 'mobile' = 'regular',
): ReturnType<typeof retreatingGarrison> {
  const setup = retreatingGarrison(mode);
  const retreat = apply(setup.state, { type: 'retreat' });
  if (retreat.error) throw new Error(retreat.error);
  const concluded = apply(retreat.state, { type: 'concludeBattle' });
  if (concluded.error) throw new Error(concluded.error);
  expect(concluded.state.infrastructure!.capture.pending).not.toBeNull();
  return { ...setup, state: concluded.state };
}

function pendingStrategicShot(): { state: GameState; targetId: string } {
  const state = configuredGame();
  const { world } = worldOf(state);
  const target = state.armies.find((holder) => holder.kind === 'commander' && holder.team === 'B')!;
  const position = neighbors(world.subByKey.get(target.pos)!.hex)
    .map(hexKey)
    .find((key) => world.subByKey.has(key) && !state.armies.some((holder) => holder.pos === key))!;
  const guard: Army = {
    id: 'save-shot-guard',
    kind: 'garrison',
    building: 'temporary',
    team: 'A',
    at: world.subByKey.get(position)!.main,
    pos: position,
    movesLeft: 0,
    units: [makeUnit(state, 'A', 'ww2_rifle_infantry')],
  };
  state.armies.push(guard);
  refreshCampaignNodeSnapshot(state);
  expect(
    campaignGarrisonTargetOptions(state, guard.units[0].id, 'strategic-after-income').some(
      (option) => option.targetId === target.id,
    ),
  ).toBe(true);
  // The initial A boundary already completed before the guard was placed. Reach
  // the next boundary through normal turns instead of replaying a paid event.
  const nextB = apply(state, { type: 'endTurn' });
  if (nextB.error) throw new Error(nextB.error);
  const nextA = apply(nextB.state, { type: 'endTurn' });
  if (nextA.error) throw new Error(nextA.error);
  expect(nextA.state.active).toBe('A');
  expect(nextA.state.infrastructure!.garrisons!.freeShots.pending).not.toBeNull();
  return { state: nextA.state, targetId: target.id };
}

function nodeGarrisonGame(): GameState {
  const state = configuredGame();
  const site = state.infrastructure!.sites.find(
    (candidate) =>
      candidate.homeTeam === null &&
      !state.armies.some((holder) => holder.at === candidate.mainHex),
  )!;
  const commander = state.armies.find(
    (holder) => holder.kind === 'commander' && holder.team === 'A',
  )!;
  commander.at = site.mainHex;
  commander.pos = site.annexSubHexes[0];
  refreshCampaignNodeSnapshot(state);
  const activated = apply(state, {
    type: 'nodeWork',
    request: constructCampaignNodeRequest(state, {
      kind: 'activate',
      nodeId: site.nodeId,
      commanderId: commander.id,
      centerDefinitionId: 'generic',
    }),
  });
  if (activated.error) throw new Error(activated.error);
  activated.state.armies.push({
    id: 'saved-node-garrison',
    kind: 'garrison',
    building: 'node',
    nodeId: site.nodeId,
    team: 'A',
    at: site.mainHex,
    pos: site.centerSubHex,
    movesLeft: 0,
    units: [makeUnit(activated.state, 'A', 'ww2_rifle_infantry')],
  });
  refreshCampaignNodeSnapshot(activated.state);
  return activated.state;
}

function pendingStartCapture(): { state: GameState; nodeId: string; holderId: string } {
  const state = configuredGame();
  const site = state.infrastructure!.sites.find(
    (candidate) =>
      candidate.homeTeam === null &&
      !state.armies.some((holder) => holder.at === candidate.mainHex),
  )!;
  const defender = state.armies.find(
    (holder) => holder.kind === 'commander' && holder.team === 'B',
  )!;
  const defenderOrigin = { at: defender.at, pos: defender.pos };
  defender.at = site.mainHex;
  defender.pos = site.annexSubHexes[0];
  refreshCampaignNodeSnapshot(state);
  const nextB = apply(state, { type: 'endTurn' });
  if (nextB.error) throw new Error(nextB.error);
  const activated = apply(nextB.state, {
    type: 'nodeWork',
    request: constructCampaignNodeRequest(nextB.state, {
      kind: 'activate',
      nodeId: site.nodeId,
      commanderId: defender.id,
      centerDefinitionId: 'generic',
    }),
  });
  if (activated.error) throw new Error(activated.error);
  Object.assign(
    activated.state.armies.find((holder) => holder.id === defender.id)!,
    defenderOrigin,
  );
  const attacker = activated.state.armies.find(
    (holder) => holder.kind === 'commander' && holder.team === 'A',
  )!;
  attacker.at = site.mainHex;
  attacker.pos = site.centerSubHex;
  const holderId = 'saved-empty-defender-node';
  activated.state.armies.push({
    id: holderId,
    kind: 'garrison',
    building: 'node',
    nodeId: site.nodeId,
    team: 'B',
    at: site.mainHex,
    pos: site.centerSubHex,
    movesLeft: 0,
    units: [],
  });
  refreshCampaignNodeSnapshot(activated.state);
  const nextA = apply(activated.state, { type: 'endTurn' });
  if (nextA.error) throw new Error(nextA.error);
  expect(nextA.state.infrastructure!.capture.pending!.event.kind).toBe('turn-start-after-income');
  return { state: nextA.state, nodeId: site.nodeId, holderId };
}

describe('GAMES-ELEVATE-SESSION-UC-001: exact saved campaign resume', () => {
  it('upgrades only the schema-2 envelope without initializing foundation state or a turn', () => {
    const state = legacyGame();
    state.turn = 7;
    state.active = 'B';
    state.cp = { A: 17, B: 4 };
    state.rng = 0xfedcba98;
    state.armies.find((holder) => holder.kind === 'commander' && holder.team === 'B')!.movesLeft =
      1;
    const loaded = deserializeSave(schemaTwo(state));
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.save.state).toEqual(state);
    expect(loaded.save.engineVersion).toBe('1.0.0-before-foundations');
    expect(loaded.save.savedAt).toBe(SAVED_AT);
    expect(loaded.migrated).toEqual([]);
    expect(Object.hasOwn(loaded.save.state, 'infrastructure')).toBe(false);
    expect(Object.hasOwn(loaded.save.state.settings, 'infrastructure')).toBe(false);
    const migration = migrateSave(state, 2);
    if (!migration.ok) throw new Error(migration.error);
    expect(migration.state).toEqual(state);
    expect(migration.state).not.toBe(state);
  });

  it('preserves saved forts with no engineer or provenance qualification', () => {
    const state = legacyGame();
    for (const holder of state.armies)
      holder.units = holder.units.filter((unit) => !unit.typeId.endsWith('_engineer'));
    const { world } = worldOf(state);
    const key = world.subs.find((cell) => !state.forts[cell.key])!.key;
    state.forts[key] = 3;
    const result = resumed(state, schemaTwo(state));
    expect(result.forts).toEqual(state.forts);
    expect(result.forts[key]).toBe(3);
    expect(result.infrastructure).toBeUndefined();
  });

  it('resumes a schema-2 battle on its exact round, active side and spent actions', () => {
    const state = battleGame();
    for (const unit of state.battle!.units) {
      delete unit.holderId;
      delete unit.stationed;
    }
    const fort = state.battle!.units[0].pos!;
    state.battle!.forts[fort] = 3;
    const result = resumed(state, schemaTwo(state));
    expect(result.battle).toEqual(state.battle);
    expect(result.battle!.round).toBe(4);
    expect(result.battle!.active).toBe('B');
    expect(result.battle!.units[0]).toMatchObject({ mp: 1, acted: true, firstStrikeUsed: true });
    expect(result.cp).toEqual({ A: 17, B: 4 });
    expect(result.rng).toBe(0xfedcba98);
  });

  it('retains a physical temporary guard after its original tile improvement is gone', () => {
    const state = battleGame(true);
    const holder = state.armies.find((army) => army.building === 'temporary')!;
    delete state.forts[holder.pos];
    delete state.battle!.forts[holder.pos];
    const result = resumed(state);
    expect(result.armies.find((army) => army.id === holder.id)).toEqual(holder);
    expect(result.battle!.units.find((unit) => unit.holderId === holder.id)).toMatchObject({
      stationed: true,
      pos: holder.pos,
      acted: true,
      suppressed: true,
    });
  });

  it('preserves optional stationed facing without changing tactical AP, position or facing on load', () => {
    const state = battleGame(true);
    const holder = state.armies.find((army) => army.building === 'temporary')!;
    holder.stationedFacing = 5;
    const loaded = resumed(state);
    expect(loaded.armies.find((army) => army.id === holder.id)!.stationedFacing).toBe(5);
    expect(loaded.battle).toEqual(state.battle);
  });

  it.each(['classic', 'configured'] as const)(
    'saves an explicit %s retreat before conclusion without moving or deleting troops',
    (mode) => {
      const state = mode === 'classic' ? battleGame(true) : retreatingGarrison().state;
      const armies = structuredClone(state.armies);
      const originalHp = state.battle!.units.map((unit) => [unit.id, unit.hp]);
      const retreated = apply(state, { type: 'retreat' });
      expect(retreated.error).toBeNull();
      const loaded = resumed(retreated.state);
      expect(loaded.battle!.withdrawnTeam).toBe('B');
      expect(loaded.battle!.departedUnitIds).toBeUndefined();
      expect(loaded.battle!.campaignLostUnitIds).toBeUndefined();
      expect(loaded.armies).toEqual(armies);
      expect(loaded.battle!.units.map((unit) => [unit.id, unit.hp])).toEqual(originalHp);
    },
  );

  it('resumes pending manual capture after a regular garrison retreat without losing stationed guards', () => {
    const { state, nodeId, garrisonId, lostUnitIds, guardId } = pendingGarrisonRetreat();
    const loaded = resumed(state);
    expect(loaded.battle!.withdrawnTeam).toBe('B');
    expect(loaded.battle!.departedUnitIds).toEqual(lostUnitIds);
    expect(loaded.battle!.campaignLostUnitIds).toEqual(lostUnitIds);
    expect(
      loaded
        .battle!.units.filter((unit) => lostUnitIds.includes(unit.id))
        .every((unit) => unit.hp > 0 && unit.stationed !== true),
    ).toBe(true);
    expect(loaded.armies.find((holder) => holder.id === garrisonId)!.units).toEqual([]);
    expect(loaded.armies.find((holder) => holder.id === guardId)).toEqual(
      state.armies.find((holder) => holder.id === guardId),
    );
    expect(loaded.infrastructure!.clock!.resolvingBattle).toEqual(loaded.battle);
    const selected = apply(loaded, { type: 'captureChoice', nodeId, outcome: 'none' });
    expect(selected.error).toBeNull();
    const savedSelection = resumed(selected.state);
    const straight = apply(selected.state, { type: 'captureCommit' });
    const restored = apply(savedSelection, { type: 'captureCommit' });
    expect(straight.error).toBeNull();
    expect(restored.error).toBeNull();
    expect(restored.state).toEqual(straight.state);
    resumed(restored.state);
    expect(restored.state.armies.find((holder) => holder.id === guardId)).toEqual(
      state.armies.find((holder) => holder.id === guardId),
    );
  });

  it('accepts only bound archived survivors when a retreating commander has no friendly fallback', () => {
    const { state, garrisonId, lostUnitIds, guardId } = pendingGarrisonRetreat('mobile');
    expect(state.armies.some((holder) => holder.id === garrisonId)).toBe(false);
    const loaded = resumed(state);
    expect(loaded.battle!.defenderArmyId).toBe(garrisonId);
    expect(new Set(loaded.battle!.campaignLostUnitIds)).toEqual(new Set(lostUnitIds));
    expect(
      loaded
        .battle!.units.filter((unit) => lostUnitIds.includes(unit.id))
        .every((unit) => unit.hp > 0),
    ).toBe(true);
    expect(loaded.armies.find((holder) => holder.id === guardId)).toEqual(
      state.armies.find((holder) => holder.id === guardId),
    );
  });

  it.each([
    'unknown',
    'duplicate',
    'not-departed',
    'wrong-team',
    'stationed',
    'missing-archive',
  ] as const)('rejects %s saved withdrawal loss metadata without recreating troops', (change) => {
    const { state, lostUnitIds, guardId } = pendingGarrisonRetreat();
    const battle = structuredClone(state.battle!);
    const firstLost = battle.units.find((unit) => unit.id === lostUnitIds[0])!;
    if (change === 'unknown') battle.campaignLostUnitIds = ['not-a-battle-unit'];
    if (change === 'duplicate') battle.campaignLostUnitIds = [lostUnitIds[0], lostUnitIds[0]];
    if (change === 'not-departed') battle.departedUnitIds = [];
    if (change === 'wrong-team') firstLost.team = 'A';
    if (change === 'stationed') {
      const guard = state.armies.find((holder) => holder.id === guardId)!.units[0];
      battle.departedUnitIds = [...lostUnitIds, guard.id];
      battle.campaignLostUnitIds = [...lostUnitIds, guard.id];
    }
    state.battle = battle;
    const f = state.infrastructure!;
    state.infrastructure = {
      ...f,
      clock: {
        ...f.clock!,
        resolvingBattle: change === 'missing-archive' ? null : structuredClone(battle),
      },
    };
    const before = JSON.stringify(state);
    const loaded = deserializeSave(serializeSave(state));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/departedUnitIds|campaignLostUnitIds|holderId/);
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([-1, 6, 1.5, null])('rejects invalid optional stationed facing %s', (facing) => {
    const state = battleGame(true);
    state.armies.find((army) => army.building === 'temporary')!.stationedFacing = facing as number;
    const loaded = deserializeSave(serializeSave(state));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/stationedFacing/);
  });

  it('preserves mid-battle Raze Tile overlay without applying persistent annex damage on load', () => {
    const { state, buildingId, nodeId } = battleWithAnnex();
    state.battle!.ruinedInfrastructureBuildingIds = [buildingId];
    const loaded = resumed(state);
    const originalNode = state.infrastructure!.capture.nodes.find((node) => node.id === nodeId)!;
    const loadedNode = loaded.infrastructure!.capture.nodes.find((node) => node.id === nodeId)!;
    expect(loaded.battle!.ruinedInfrastructureBuildingIds).toEqual([buildingId]);
    expect(loadedNode).toEqual(originalNode);
    expect(loadedNode.buildings.find((building) => building.id === buildingId)!.ruined).toBe(false);
    expect(loaded.infrastructure!.capture.work).toEqual(state.infrastructure!.capture.work);
  });

  it.each(['not-array', 'duplicate', 'unknown', 'center', 'outside-battle'] as const)(
    'rejects %s IDs in the saved tactical Raze Tile overlay',
    (change) => {
      const { state, buildingId, nodeId } = battleWithAnnex(change !== 'outside-battle');
      state.battle!.ruinedInfrastructureBuildingIds =
        change === 'not-array'
          ? (buildingId as never)
          : change === 'duplicate'
            ? [buildingId, buildingId]
            : change === 'unknown'
              ? ['missing-annex']
              : change === 'center'
                ? [`${nodeId}:center`]
                : [buildingId];
      const before = JSON.stringify(state);
      const loaded = deserializeSave(serializeSave(state));
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error).toMatch(/ruinedInfrastructureBuildingIds/);
      expect(JSON.stringify(state)).toBe(before);
    },
  );

  it('validates saved Raze Tile identity without requalifying it against current node ownership', () => {
    const { state, buildingId, nodeId } = battleWithAnnex();
    state.battle!.ruinedInfrastructureBuildingIds = [buildingId];
    const f = state.infrastructure!;
    state.infrastructure = {
      ...f,
      capture: {
        ...f.capture,
        nodes: f.capture.nodes.map((node) => (node.id === nodeId ? { ...node, owner: 'B' } : node)),
      },
    };
    resumed(state);
  });

  it.each([
    [
      'empty temporary holder',
      (holder: Army) => {
        holder.units = [];
      },
    ],
    [
      'overfilled temporary holder',
      (holder: Army) => {
        holder.units.push({ ...holder.units[0], id: 'extra-guard' });
      },
    ],
    [
      'moving temporary holder',
      (holder: Army) => {
        holder.movesLeft = 1;
      },
    ],
    [
      'dead temporary guard',
      (holder: Army) => {
        holder.units[0].hp = 0;
      },
    ],
  ] as const)('rejects %s without repairing or advancing the state', (_, change) => {
    const state = battleGame(true);
    change(state.armies.find((army) => army.building === 'temporary')!);
    const before = JSON.stringify(state);
    expect(deserializeSave(serializeSave(state)).ok).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each(['missing-holder', 'wrong-holder', 'unmarked', 'moved'] as const)(
    'rejects %s stationed tactical identity',
    (change) => {
      const state = battleGame(true);
      const guard = state.battle!.units.find((unit) => unit.stationed)!;
      if (change === 'missing-holder') delete guard.holderId;
      if (change === 'wrong-holder') guard.holderId = state.battle!.attackerArmyId;
      if (change === 'unmarked') delete guard.stationed;
      if (change === 'moved') {
        const world = buildWorld(state.settings.grid);
        guard.pos = world.subs.find(
          (cell) => !state.battle!.units.some((unit) => unit.pos === cell.key),
        )!.key;
      }
      const loaded = deserializeSave(serializeSave(state));
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error).toMatch(/stationed|holderId/);
    },
  );

  it('round-trips an actual configured campaign without paying, resetting or repricing it', () => {
    const state = configuredGame();
    const result = resumed(state);
    expect(result.infrastructure).toEqual(state.infrastructure);
    expect(result.settings.infrastructure).toEqual(state.settings.infrastructure);
  });

  it('delegates invalid optional configuration and runtime records instead of initializing them', () => {
    for (const value of [null, {}]) {
      const configured = legacyGame();
      configured.settings.infrastructure = value as never;
      const settingResult = deserializeSave(serializeSave(configured));
      expect(settingResult.ok).toBe(false);
      if (!settingResult.ok) expect(settingResult.error).toMatch(/settings.infrastructure/);

      const malformed = legacyGame();
      malformed.infrastructure = value as never;
      const runtimeResult = deserializeSave(serializeSave(malformed));
      expect(runtimeResult.ok).toBe(false);
      if (!runtimeResult.ok) expect(runtimeResult.error).toMatch(/infrastructure/);
    }
  });

  it('does not fill in missing runtime progress from a valid settings profile', () => {
    const state = legacyGame();
    state.settings.infrastructure = createFoundationPlaytestConfiguration(7, 3);
    const loaded = deserializeSave(serializeSave(state));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/infrastructure.*missing/i);
    expect(state.infrastructure).toBeUndefined();
  });

  it.each(['off-map', 'wrong-MainHex', 'duplicate-edge'] as const)(
    'rejects a %s saved road against the actual world without repairing it',
    (change) => {
      const state = configuredGame();
      const foundation = state.infrastructure!;
      const site = foundation.sites[0];
      const path = [site.centerSubHex, site.annexSubHexes[0]];
      const road = { id: 'saved-road', mainHex: site.mainHex, path, damaged: false };
      const roads =
        change === 'off-map'
          ? [{ ...road, path: ['999,999'] }]
          : change === 'wrong-MainHex'
            ? [{ ...road, mainHex: foundation.sites[1].mainHex }]
            : [road, { ...road, id: 'overlapping-road', path: [...path].reverse() }];
      state.infrastructure = { ...foundation, supply: { ...foundation.supply!, roads } };
      const before = JSON.stringify(state);
      const loaded = deserializeSave(serializeSave(state));
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error).toMatch(/infrastructure:.*road/i);
      expect(JSON.stringify(state)).toBe(before);
    },
  );

  it('preserves a valid local damaged road without repairing it or paying again', () => {
    const state = configuredGame();
    const foundation = state.infrastructure!;
    const site = foundation.sites[0];
    const road = {
      id: 'saved-damaged-road',
      mainHex: site.mainHex,
      path: [site.centerSubHex, site.annexSubHexes[0]],
      damaged: true,
    };
    state.infrastructure = { ...foundation, supply: { ...foundation.supply!, roads: [road] } };
    const loaded = resumed(state);
    expect(loaded.infrastructure!.supply!.roads).toEqual([road]);
    expect(loaded.cp).toEqual(state.cp);
    expect(loaded.infrastructure!.clock).toEqual(state.infrastructure!.clock);
  });

  it.each(['land', 'marsh'] as const)(
    'rejects a campaign configuration missing the %s terrain cost before initialization',
    (terrain) => {
      const configuration = createFoundationPlaytestConfiguration(7, 3);
      const terrainCosts = { ...configuration.supply.terrainCosts };
      delete terrainCosts[terrain];
      const missing = { ...configuration, supply: { ...configuration.supply, terrainCosts } };
      const before = JSON.stringify(missing);
      expect(validateCampaignConfiguration(missing)).toContain(
        'Campaign supply requires both land and marsh costs',
      );
      expect(() => configuredWith(missing)).toThrow(/land and marsh/);
      const state = legacyGame();
      state.settings.infrastructure = missing;
      const loaded = deserializeSave(serializeSave(state));
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error).toMatch(/settings.infrastructure:.*land and marsh/);
      expect(JSON.stringify(missing)).toBe(before);
    },
  );

  it('rejects an unrounded profile whose future connected Regional HQ produces fractional units', () => {
    const configuration = createFoundationPlaytestConfiguration(7, 3);
    const fractional: CampaignConfiguration = {
      ...configuration,
      benefits: configuration.benefits.map((benefit) =>
        benefit.id === 'reinforcement' ? { ...benefit, rounding: 'none' } : benefit,
      ),
    };
    // The initial Home HQ's 10 is whole; a legal T2 Regional HQ's 14 × 1.25 is not.
    expect(validateCampaignConfiguration(fractional)).toContain(
      'Configured reinforcement modifiers can produce an invalid unit count',
    );
    expect(() => configuredWith(fractional)).toThrow(/invalid unit count/);
  });

  it('accepts explicit integer rounding of the same fractional Regional HQ boost', () => {
    const configuration = createFoundationPlaytestConfiguration(7, 3);
    expect(validateCampaignConfiguration(configuration)).toEqual([]);
    resumed(configuredWith(configuration));
  });

  it('permits no rounding when all configured HQ and regional outputs remain whole', () => {
    const configuration = createFoundationPlaytestConfiguration(7, 3);
    const whole: CampaignConfiguration = {
      ...configuration,
      benefits: configuration.benefits.map((benefit) =>
        benefit.id === 'reinforcement'
          ? {
              ...benefit,
              rounding: 'none',
              homeConnectedBoost: { operation: 'multiply', value: 2, cap: null },
            }
          : benefit,
      ),
    };
    expect(validateCampaignConfiguration(whole)).toEqual([]);
    resumed(configuredWith(whole));
  });

  it('compares equivalent saved profiles independently of JSON object key order', () => {
    const state = configuredGame();
    const foundation = state.infrastructure!;
    state.infrastructure = {
      ...foundation,
      configuration: reverseObjectKeys(foundation.configuration!),
      profile: reverseObjectKeys(foundation.profile),
      supply: {
        ...foundation.supply!,
        profile: reverseObjectKeys(foundation.supply!.profile),
        benefits: reverseObjectKeys(foundation.supply!.benefits),
      },
    };
    expect(JSON.stringify(state.infrastructure.configuration)).not.toBe(
      JSON.stringify(state.settings.infrastructure),
    );
    resumed(state);
  });

  it('rejects a genuinely different saved supply profile without replacing it from settings', () => {
    const state = configuredGame();
    const foundation = state.infrastructure!;
    state.infrastructure = {
      ...foundation,
      supply: {
        ...foundation.supply!,
        profile: { ...foundation.supply!.profile, legRange: 123 },
      },
    };
    const before = JSON.stringify(state);
    const loaded = deserializeSave(serializeSave(state));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/Supply profile differs from configured rules/);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('allows an empty building garrison to share its center only in configured mode', () => {
    for (const foundation of [false, true]) {
      const state = foundation ? configuredGame() : legacyGame();
      const commander = state.armies.find(
        (holder) => holder.kind === 'commander' && holder.team === 'A',
      )!;
      const hq = state.armies.find((holder) => holder.building === 'hq' && holder.team === 'A')!;
      commander.pos = hq.pos;
      commander.at = hq.at;
      if (foundation) resumed(state);
      else expect(deserializeSave(serializeSave(state)).ok).toBe(false);
    }
  });

  it('rejects overlapping living holders even in configured mode', () => {
    const state = configuredGame();
    const commander = state.armies.find(
      (holder) => holder.kind === 'commander' && holder.team === 'A',
    )!;
    const hq = state.armies.find((holder) => holder.building === 'hq' && holder.team === 'A')!;
    hq.units.push(makeUnit(state, 'A', 'ww2_rifle_infantry'));
    commander.pos = hq.pos;
    commander.at = hq.at;
    const loaded = deserializeSave(serializeSave(state));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/shares sub-hex/);
  });

  it('preserves a bound node garrison and the activation expenditure exactly', () => {
    const state = nodeGarrisonGame();
    const result = resumed(state);
    expect(result.armies.find((holder) => holder.building === 'node')).toEqual(
      state.armies.find((holder) => holder.building === 'node'),
    );
    expect(result.infrastructure!.activationReceipts).toHaveLength(1);
    expect(result.infrastructure!.capture.work.nodeSpending).toEqual(
      state.infrastructure!.capture.work.nodeSpending,
    );
  });

  it.each(['missing-node', 'foreign-owner', 'off-center', 'moving'] as const)(
    'rejects a %s node garrison without rebinding it on load',
    (change) => {
      const state = nodeGarrisonGame();
      const holder = state.armies.find((army) => army.building === 'node')!;
      if (change === 'missing-node') holder.nodeId = 'missing-node';
      if (change === 'foreign-owner') holder.team = 'B';
      if (change === 'off-center') {
        const site = state.infrastructure!.sites.find(
          (candidate) => candidate.nodeId === holder.nodeId,
        )!;
        holder.pos = site.annexSubHexes[1];
      }
      if (change === 'moving') holder.movesLeft = 1;
      const before = JSON.stringify(state);
      const loaded = deserializeSave(serializeSave(state));
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error).toMatch(/node garrison|node.*cannot move/);
      expect(JSON.stringify(state)).toBe(before);
    },
  );

  it('does not reconcile corrupted CP snapshots or duplicate paid-event history on load', () => {
    const original = configuredGame();
    for (const change of ['cp', 'paid-income'] as const) {
      const state = structuredClone(original);
      if (change === 'cp') {
        state.cp.A += 1;
      } else {
        const clock = state.infrastructure!.clock!;
        expect(clock.paidIncomeEvents.length).toBeGreaterThan(0);
        state.infrastructure = {
          ...state.infrastructure!,
          clock: {
            ...clock,
            paidIncomeEvents: [...clock.paidIncomeEvents, clock.paidIncomeEvents[0]],
          },
        };
      }
      const before = JSON.stringify(state);
      const loaded = deserializeSave(serializeSave(state));
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error).toMatch(/infrastructure/);
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it('resumes manual capture and Do nothing choices without restoring casualties or paying again', () => {
    const state = pendingManualCapture();
    const pending = state.infrastructure!.capture.pending!;
    const nodeId = pending.candidates[0].node.id;
    const before = resumed(state);
    const selected = apply(before, { type: 'captureChoice', nodeId, outcome: 'none' });
    expect(selected.error).toBeNull();
    const savedChoice = resumed(selected.state);
    const originalCommit = apply(selected.state, { type: 'captureCommit' });
    const restoredCommit = apply(savedChoice, { type: 'captureCommit' });
    expect(originalCommit.error).toBeNull();
    expect(restoredCommit.error).toBeNull();
    expect(restoredCommit.state).toEqual(originalCommit.state);
    const committed = resumed(restoredCommit.state);
    expect(committed.cp.A).toBe(0);
    expect(committed.infrastructure!.capture.nodes.find((node) => node.id === nodeId)!.owner).toBe(
      'B',
    );
    expect(committed.infrastructure!.clock!.paidIncomeEvents).toEqual(
      state.infrastructure!.clock!.paidIncomeEvents,
    );
    expect(
      committed.battle!.units.filter((unit) => unit.team === 'B').every((unit) => unit.hp === 0),
    ).toBe(true);
  });

  it('allows no winner only for the bound configured manual-capture resolution', () => {
    const state = pendingManualCapture();
    const foundation = state.infrastructure!;
    state.battle = { ...state.battle!, winner: null };
    state.infrastructure = {
      ...foundation,
      clock: {
        ...foundation.clock!,
        resolvingBattle: structuredClone(state.battle),
      },
    };
    resumed(state);
  });

  it.each(['classic', 'missing-archive', 'different-archive-id', 'no-pending-capture'] as const)(
    'retains the winner requirement for an unbound %s final battle',
    (change) => {
      const state = change === 'classic' ? battleGame() : pendingManualCapture();
      state.battle = {
        ...state.battle!,
        phase: 'over',
        winner: null,
        endReason: 'Saved final state',
      };
      if (state.infrastructure) {
        const foundation = state.infrastructure;
        state.infrastructure = {
          ...foundation,
          capture:
            change === 'no-pending-capture'
              ? { ...foundation.capture, pending: null }
              : foundation.capture,
          clock: {
            ...foundation.clock!,
            resolvingBattle:
              change === 'missing-archive'
                ? null
                : {
                    ...structuredClone(state.battle),
                    id: change === 'different-archive-id' ? 'other-battle' : state.battle.id,
                  },
          },
        };
      }
      const loaded = deserializeSave(serializeSave(state));
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error).toMatch(/battle.phase is over but no winner/);
    },
  );

  it.each(['archive', 'battle'] as const)(
    'rejects a divergent %s snapshot while manual Capture choices are pending',
    (change) => {
      const state = pendingManualCapture();
      const foundation = state.infrastructure!;
      expect(foundation.clock!.resolvingBattle!.id).toBe(state.battle!.id);
      const altered = structuredClone(
        change === 'archive' ? foundation.clock!.resolvingBattle! : state.battle!,
      );
      altered.units[0].acted = !altered.units[0].acted;
      if (change === 'archive')
        state.infrastructure = {
          ...foundation,
          clock: { ...foundation.clock!, resolvingBattle: altered },
        };
      else state.battle = altered;
      const before = JSON.stringify(state);
      const loaded = deserializeSave(serializeSave(state));
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error).toMatch(/Saved final battle snapshots disagree/);
      expect(JSON.stringify(state)).toBe(before);
    },
  );

  it.each(['capture', 'raze'] as const)(
    'saves a real turn-start %s after removing the empty previous-owner garrison',
    (outcome) => {
      const { state, nodeId, holderId } = pendingStartCapture();
      const ready = resumed(state);
      const selected = apply(ready, { type: 'captureChoice', nodeId, outcome });
      expect(selected.error).toBeNull();
      const restoredSelection = resumed(selected.state);
      const straight = apply(selected.state, { type: 'captureCommit' });
      const restored = apply(restoredSelection, { type: 'captureCommit' });
      expect(straight.error).toBeNull();
      expect(restored.error).toBeNull();
      expect(restored.state).toEqual(straight.state);
      const completed = resumed(restored.state);
      expect(completed.armies.some((holder) => holder.id === holderId)).toBe(false);
      expect(
        completed.infrastructure!.capture.nodes.find((node) => node.id === nodeId)!.owner,
      ).toBe(outcome === 'capture' ? 'A' : null);
      expect(completed.cp.A).toBe(state.cp.A - (outcome === 'capture' ? 7 : 3));
      expect(completed.infrastructure!.clock!.paidIncomeEvents).toEqual(
        state.infrastructure!.clock!.paidIncomeEvents,
      );
    },
  );

  it('resumes pending free-shot target selection with the same RNG outcome and one shared expenditure', () => {
    const { state, targetId } = pendingStrategicShot();
    const ready = resumed(state);
    const selected = apply(ready, { type: 'freeShotTarget', targetId });
    expect(selected.error).toBeNull();
    const savedSelection = resumed(selected.state);
    expect(savedSelection.rng).toBe(state.rng);
    const originalShot = apply(selected.state, { type: 'freeShotResolve' });
    const restoredShot = apply(savedSelection, { type: 'freeShotResolve' });
    expect(originalShot.error).toBeNull();
    expect(restoredShot.error).toBeNull();
    expect(restoredShot.state).toEqual(originalShot.state);
    const completed = resumed(restoredShot.state);
    expect(completed.infrastructure!.garrisons!.freeShots.receipts).toHaveLength(1);
    expect(completed.infrastructure!.clock!.paidIncomeEvents).toEqual(
      state.infrastructure!.clock!.paidIncomeEvents,
    );
    expect(completed.cp).toEqual(state.cp);
    const repeated = apply(completed, { type: 'freeShotResolve' });
    expect(repeated.error).not.toBeNull();
    expect(repeated.state).toBe(completed);
    expect(repeated.state.rng).toBe(completed.rng);
  });
});
