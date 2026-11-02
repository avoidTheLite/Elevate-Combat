import { describe, expect, it } from 'vitest';
import { apply } from './actions.ts';
import { canEngage } from './command.ts';
import {
  commitEngagementCosts,
  engagementCandidates,
  engagementCosts,
  engagementParticipantSnapshots,
  EXPERIMENTAL_ENGAGEMENT_PROFILE,
  validateEngagementProfile,
  validatePendingEngagement,
} from './engagement.ts';
import { hexDistance, hexKey, neighbors } from './hex.ts';
import { actingTeam, aiStep, isAiTurn } from './runner.ts';
import {
  COMMAND,
  createGame,
  defaultSettings,
  makeUnit,
  setHolderPos,
  worldOf,
} from './strategic.ts';
import type { Army, GameState, Team } from './types.ts';

function fixture(): GameState {
  const state = createGame({
    ...defaultSettings(),
    grid: { mainCols: 5, mainRows: 3, subRadius: 2 },
    controllers: { A: 'human', B: 'human' },
    commanderTrainingCp: 11,
    fog: false,
    engagement: { ...EXPERIMENTAL_ENGAGEMENT_PROFILE },
  });
  state.armies = [];
  state.cp = { A: 100, B: 100 };
  const world = worldOf(state).world;
  const main = world.mains.find((m) => m.col === 2 && m.row === 1)!;
  const cells = main.subKeys;
  add(state, 'A', cells[0]!, 'attacker');
  add(
    state,
    'B',
    neighbors(world.subByKey.get(cells[0]!)!.hex)
      .map(hexKey)
      .find((key) => main.subKeys.includes(key))!,
    'defender',
  );
  return state;
}

function add(state: GameState, team: Team, pos: string, id: string, movesLeft = 5): Army {
  const army: Army = {
    id,
    team,
    pos,
    at: '',
    kind: 'commander',
    units: [makeUnit(state, team, 'ww2_rifle_infantry')],
    movesLeft,
  };
  setHolderPos(worldOf(state).world, army, pos);
  state.armies.push(army);
  return army;
}

function freeInMain(state: GameState): string {
  const main = state.armies.find((a) => a.id === 'attacker')!.at;
  const occupied = new Set(state.armies.map((a) => a.pos));
  return worldOf(state)
    .world.mainByKey.get(main)!
    .subKeys.find((key) => !occupied.has(key))!;
}

function pending(state: GameState): GameState {
  const result = apply(state, { type: 'engage', armyId: 'attacker', targetId: 'defender' });
  expect(result.error).toBeNull();
  return result.state;
}

function step(state: GameState, action: Parameters<typeof apply>[1]): GameState {
  const result = apply(state, action);
  expect(result.error).toBeNull();
  return result.state;
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: explicit commander participation', () => {
  it('uses a trial base price independently of army size and preserves legacy affordability', () => {
    const state = fixture();
    const att = state.armies[0]!;
    for (let i = 0; i < 5; i++) att.units.push(makeUnit(state, 'A', 'ww2_rifle_infantry'));
    state.cp.A = 5;
    expect(canEngage(state, att, state.armies[1]).ok).toBe(true);
    const p = pending(state);
    expect(engagementCosts(p, p.pending!)).toEqual({ A: 5, B: 0 });
    delete state.settings.engagement;
    expect(canEngage(state, att, state.armies[1]).ok).toBe(false);
  });

  it('includes a same-MainHex commander with zero movement without moving it', () => {
    const state = fixture();
    const extra = add(state, 'A', freeInMain(state), 'already-there', 0);
    const before = structuredClone(extra);
    const p = pending(state);
    expect(engagementCandidates(p, 'A').find((c) => c.armyId === extra.id)).toEqual({
      armyId: extra.id,
      alreadyPresent: true,
      steps: 0,
    });
    const selected = step(p, {
      type: 'engagementSelect',
      team: 'A',
      armyIds: ['attacker', extra.id],
    });
    expect(selected.armies.find((a) => a.id === extra.id)).toEqual(before);
    expect(selected.cp).toEqual(state.cp);
  });

  it('qualifies defender reinforcements from actual remaining movement without active-side orders', () => {
    const state = fixture();
    const world = worldOf(state).world;
    const main = state.armies[0]!.at;
    const occupied = new Set(state.armies.map((a) => a.pos));
    const pos = world.subs.find(
      (cell) =>
        cell.main !== main &&
        !occupied.has(cell.key) &&
        neighbors(cell.hex).some((hex) => world.subByKey.get(hexKey(hex))?.main === main),
    )!.key;
    const extra = add(state, 'B', pos, 'defense-reach', 1);
    const p = pending(state);
    expect(engagementCandidates(p, 'B').find((c) => c.armyId === extra.id)).toEqual({
      armyId: extra.id,
      alreadyPresent: false,
      steps: 1,
    });
    expect(p.active).toBe('A');
    extra.movesLeft = 0;
    const exhausted = pending(state);
    expect(engagementCandidates(exhausted, 'B').find((c) => c.armyId === extra.id)?.reason).toMatch(
      /remaining/,
    );
  });

  it('rejects a geometrically near commander whose actual paths are blocked', () => {
    const state = fixture();
    const world = worldOf(state).world;
    const main = state.armies[0]!.at;
    const primaryPositions = new Set(state.armies.map((a) => a.pos));
    const cell = world.subs.find(
      (s) =>
        s.main !== main &&
        hexDistance(s.hex, world.subByKey.get(state.armies[0]!.pos)!.hex) <=
          COMMAND.commandMove(2) &&
        neighbors(s.hex).every((h) => !primaryPositions.has(hexKey(h))),
    )!;
    const extra = add(state, 'A', cell.key, 'blocked-extra', 5);
    for (const h of neighbors(cell.hex)) {
      const key = hexKey(h);
      if (!world.subByKey.has(key)) continue;
      const blocker = add(state, 'A', key, `blocker-${key}`, 0);
      blocker.kind = 'garrison';
      blocker.building = 'temporary';
    }
    const p = pending(state);
    const candidate = engagementCandidates(p, 'A').find((c) => c.armyId === extra.id)!;
    expect(candidate.steps).toBe(Infinity);
    expect(candidate.reason).toMatch(/Cannot reach/);
    const result = apply(p, {
      type: 'engagementSelect',
      team: 'A',
      armyIds: ['attacker', extra.id],
    });
    expect(result.error).toMatch(/Cannot reach/);
    expect(result.state).toBe(p);
  });

  it('requires mandatory unique own holders and locks attacker before defender', () => {
    let p = pending(fixture());
    expect(actingTeam(p)).toBe('A');
    expect(apply(p, { type: 'engagementSelect', team: 'B', armyIds: ['defender'] }).error).toMatch(
      /locked/,
    );
    expect(apply(p, { type: 'engagementSelect', team: 'A', armyIds: [] }).error).toMatch(
      /mandatory/,
    );
    expect(
      apply(p, { type: 'engagementSelect', team: 'A', armyIds: ['attacker', 'attacker'] }).error,
    ).toMatch(/unique/);
    expect(
      apply(p, { type: 'engagementSelect', team: 'A', armyIds: ['attacker', 'defender'] }).error,
    ).toMatch(/other side/);
    p = step(p, { type: 'engagementLock', team: 'A' });
    expect(actingTeam(p)).toBe('B');
    expect(apply(p, { type: 'engagementSelect', team: 'A', armyIds: ['attacker'] }).error).toMatch(
      /locked/,
    );
    p = step(p, { type: 'engagementLock', team: 'B' });
    expect(p.pending!.participation!.stage).toBe('ready');
  });

  it('quotes 9 CP for three attackers, bills extras to their own side and changes no movement', () => {
    const state = fixture();
    for (const [team, id] of [
      ['A', 'a2'],
      ['A', 'a3'],
      ['B', 'b2'],
      ['B', 'b3'],
    ] as const)
      add(state, team, freeInMain(state), id);
    const originalHolders = structuredClone(state.armies);
    let p = pending(state);
    p = step(p, { type: 'engagementSelect', team: 'A', armyIds: ['attacker', 'a2', 'a3'] });
    p = step(p, { type: 'engagementLock', team: 'A' });
    p = step(p, { type: 'engagementSelect', team: 'B', armyIds: ['defender', 'b2', 'b3'] });
    p = step(p, { type: 'engagementLock', team: 'B' });
    expect(engagementCosts(p, p.pending!)).toEqual({ A: 9, B: 4 });
    expect(engagementParticipantSnapshots(p, p.pending!).map((x) => x.armyId)).toEqual([
      'attacker',
      'a2',
      'a3',
      'defender',
      'b2',
      'b3',
    ]);
    expect(commitEngagementCosts(p, p.pending!).ok).toBe(true);
    expect(p.cp).toEqual({ A: 91, B: 96 });
    expect(p.armies).toEqual(originalHolders);
  });

  it('keeps initial defense legal at zero CP and atomically rejects stale opposing affordability', () => {
    const state = fixture();
    add(state, 'B', freeInMain(state), 'b2');
    let p = pending(state);
    p = step(p, { type: 'engagementLock', team: 'A' });
    p = step(p, { type: 'engagementSelect', team: 'B', armyIds: ['defender', 'b2'] });
    p = step(p, { type: 'engagementLock', team: 'B' });
    p.cp.B = 1;
    const before = structuredClone(p);
    expect(commitEngagementCosts(p, p.pending!).ok).toBe(false);
    expect(p).toEqual(before);
    p.cp.B = 0;
    p = step(p, { type: 'engagementSelect', team: 'B', armyIds: ['defender'] });
    p = step(p, { type: 'engagementLock', team: 'B' });
    expect(validatePendingEngagement(p).ok).toBe(true);
    expect(engagementCosts(p, p.pending!)).toEqual({ A: 5, B: 0 });
  });

  it('cannot commit an unlocked selection and cancellation spends nothing', () => {
    const state = fixture();
    const original = structuredClone(state);
    const p = pending(state);
    expect(commitEngagementCosts(p, p.pending!).ok).toBe(false);
    const cancelled = step(p, { type: 'cancelBattle' });
    expect(cancelled.phase).toBe('strategic');
    for (const key of ['armies', 'cp', 'rng', 'nextId', 'hexes', 'forts'] as const)
      expect(cancelled[key]).toEqual(original[key]);
  });

  it('keeps all previews pure and blocks start/auto before both sides lock', () => {
    const p = pending(fixture());
    const before = structuredClone(p);
    engagementCandidates(p, 'A');
    engagementCandidates(p, 'B');
    engagementCosts(p, p.pending!);
    validatePendingEngagement(p);
    engagementParticipantSnapshots(p, p.pending!);
    aiStep(p);
    expect(p).toEqual(before);
    for (const type of ['startBattle', 'autoResolve'] as const) {
      const result = apply(p, { type });
      expect(result.error).toMatch(/lock/);
      expect(result.state).toBe(p);
      expect(result.state).toEqual(before);
    }
    let ready = step(p, { type: 'engagementLock', team: 'A' });
    ready = step(ready, { type: 'engagementLock', team: 'B' });
    const opened = step(ready, { type: 'startBattle' });
    expect(opened.cp).toEqual({ A: 95, B: 100 });
    const repeat = apply(opened, { type: 'startBattle' });
    expect(repeat.error).toMatch(/No pending/);
    expect(repeat.state).toBe(opened);
  });

  it('invalidates downstream defender choices when a ready attacker selection is reopened', () => {
    const state = fixture();
    add(state, 'B', freeInMain(state), 'b2');
    let p = pending(state);
    p = step(p, { type: 'engagementLock', team: 'A' });
    p = step(p, { type: 'engagementSelect', team: 'B', armyIds: ['defender', 'b2'] });
    p = step(p, { type: 'engagementLock', team: 'B' });
    const before = structuredClone(p);
    p = step(p, { type: 'engagementSelect', team: 'A', armyIds: ['attacker'] });
    expect(p.pending!.participation).toEqual({
      attackerIds: ['attacker'],
      defenderIds: ['defender'],
      stage: 'attacker',
    });
    expect(p.armies).toEqual(before.armies);
    expect(p.cp).toEqual(before.cp);
  });

  it('selects and locks for AI sides but stops for each human choice', () => {
    const state = fixture();
    state.settings.controllers = { A: 'ai', B: 'human' };
    add(state, 'A', freeInMain(state), 'ai-extra');
    let p = pending(state);
    expect(isAiTurn(p)).toBe(true);
    const selection = aiStep(p);
    expect(selection).toEqual({
      type: 'engagementSelect',
      team: 'A',
      armyIds: ['attacker', 'ai-extra'],
    });
    p = step(p, selection);
    p = step(p, aiStep(p));
    expect(p.pending!.participation!.stage).toBe('defender');
    expect(actingTeam(p)).toBe('B');
    expect(isAiTurn(p)).toBe(false);
    p = step(p, { type: 'engagementLock', team: 'B' });
    expect(isAiTurn(p)).toBe(false);
    state.settings.controllers = { A: 'human', B: 'ai' };
    p = pending(state);
    expect(isAiTurn(p)).toBe(false);
    p = step(p, { type: 'engagementLock', team: 'A' });
    expect(isAiTurn(p)).toBe(true);
  });

  it('validates explicit profile inputs and preserves omission for old saves', () => {
    expect(validateEngagementProfile(undefined)).toBeNull();
    expect(validateEngagementProfile(EXPERIMENTAL_ENGAGEMENT_PROFILE)).toBeNull();
    for (const value of [
      null,
      [],
      {},
      { ...EXPERIMENTAL_ENGAGEMENT_PROFILE, attackBaseCp: 0 },
      { ...EXPERIMENTAL_ENGAGEMENT_PROFILE, additionalDefenderCp: -1 },
      { ...EXPERIMENTAL_ENGAGEMENT_PROFILE, extra: true },
    ])
      expect(validateEngagementProfile(value)).toBeTypeOf('string');
  });

  it('resumes an established legacy pending fight without replaying new-attack eligibility', () => {
    const state = fixture();
    delete state.settings.engagement;
    const { world } = worldOf(state);
    const attacker = state.armies[0]!;
    const defender = state.armies[1]!;
    const origin = world.mains.find((main) => main.col === 0 && main.row === 1)!;
    const target = world.mains.find((main) => main.col === 1 && main.row === 1)!;
    setHolderPos(world, attacker, hexKey(origin.center));
    setHolderPos(world, defender, hexKey(target.center));
    attacker.movesLeft = 0;
    state.pending = {
      attackerArmyId: attacker.id,
      defenderArmyId: defender.id,
      origin: origin.key,
      target: target.key,
    };
    state.phase = 'battle-pending';
    expect(canEngage({ ...state, phase: 'strategic' }, attacker, defender).ok).toBe(false);
    const beforeCp = state.cp.A;
    const opened = apply(state, { type: 'startBattle' });
    expect(opened.error).toBeNull();
    expect(opened.state.battle?.origin).toBe(origin.key);
    expect(opened.state.battle?.contested).toBe(target.key);
    expect(opened.state.battle?.participants).toBeUndefined();
    expect(opened.state.cp.A).toBe(beforeCp - 5); // Retained 4 + one unit.
    expect(state.cp.A).toBe(beforeCp);
    const resolved = apply(state, { type: 'autoResolve' });
    expect(resolved.error).toBeNull();
    expect(resolved.state.cp.A).toBe(beforeCp - 5);
  });

  it('keeps current initiation checks mandatory for an opted-in pending selection', () => {
    const state = fixture();
    const { world } = worldOf(state);
    const attacker = state.armies[0]!;
    const defender = state.armies[1]!;
    const origin = world.mains.find((main) => main.col === 0 && main.row === 1)!;
    const target = world.mains.find((main) => main.col === 1 && main.row === 1)!;
    setHolderPos(world, attacker, hexKey(origin.center));
    setHolderPos(world, defender, hexKey(target.center));
    state.pending = {
      attackerArmyId: attacker.id,
      defenderArmyId: defender.id,
      origin: origin.key,
      target: target.key,
      participation: { attackerIds: [attacker.id], defenderIds: [defender.id], stage: 'ready' },
    };
    state.phase = 'battle-pending';
    for (const type of ['startBattle', 'autoResolve'] as const) {
      const result = apply(state, { type });
      expect(result.error).toMatch(/range/);
      expect(result.state).toBe(state);
    }
  });
});
