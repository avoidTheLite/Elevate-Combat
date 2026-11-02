// GAMES-ELEVATE-CAMPAIGN-UC-002 / GAMES-ELEVATE-TACTICAL-UC-001 /
// GAMES-ELEVATE-SESSION-UC-001: independent cross-boundary engagement regressions.
import { describe, expect, it } from 'vitest';
import { apply } from './actions.ts';
import type { GameAction } from './actions.ts';
import { deploymentZone } from './battleMap.ts';
import { EXPERIMENTAL_ENGAGEMENT_PROFILE } from './engagement.ts';
import { hexDistance, parseKey } from './hex.ts';
import { deserializeSave, serializeSave, validateGameState } from './save.ts';
import { createGame, defaultSettings, makeUnit, setHolderPos, worldOf } from './strategic.ts';
import { contextFor } from './tactical.ts';
import type { Army, GameState, Team } from './types.ts';
import { refreshCampaignNodeSnapshot } from './foundation/campaignNodes.ts';
import { createFoundationPlaytestConfiguration } from './foundation/playtestProfile.ts';

interface Fixture {
  state: GameState;
  attackerId: string;
  defenderId: string;
  extraAttackerId: string;
  extraDefenderId: string;
  declinedId: string;
}

/** Only the initial campaign posture is prepared; all selections and commits use real actions. */
function fixture(foundation = false): Fixture {
  const state = createGame({
    ...defaultSettings(),
    grid: { mainCols: 5, mainRows: 3, subRadius: 2 },
    seed: 37,
    fog: false,
    commanderTrainingCp: 11,
    controllers: { A: 'human', B: 'human' },
    engagement: { ...EXPERIMENTAL_ENGAGEMENT_PROFILE },
    ...(foundation ? { infrastructure: createFoundationPlaytestConfiguration(7, 3) } : {}),
  });
  const { world } = worldOf(state);
  const main = world.mains.find((m) => m.col === 2 && m.row === 1)!;
  const neighbour = world.mains.find((m) => m.col === 1 && m.row === 1)!;
  const center = `${main.center.q},${main.center.r}`;
  const beside = main.subKeys.filter(
    (key) => key !== center && hexDistance(parseKey(key), main.center) <= 1,
  );
  const initial = (team: Team): Army =>
    state.armies.find((a) => a.kind === 'commander' && a.team === team)!;
  const attacker = initial('A');
  const defender = initial('B');
  attacker.units = [attacker.units[0]!];
  defender.units = [defender.units[0]!];
  setHolderPos(world, attacker, beside[0]!);
  setHolderPos(world, defender, center);
  function additional(team: Team, pos: string, movesLeft: number): Army {
    const army: Army = {
      id: `integration-holder-${state.nextId++}`,
      kind: 'commander',
      team,
      pos,
      at: '',
      movesLeft,
      units: [makeUnit(state, team, 'ww2_rifle_infantry')],
    };
    setHolderPos(world, army, pos);
    state.armies.push(army);
    return army;
  }
  const extraAttacker = additional('A', `${neighbour.center.q},${neighbour.center.r}`, 5);
  const extraDefender = additional('B', beside[1]!, 3);
  const declined = additional('B', beside[2]!, 2);
  state.cp = { A: 60, B: 60 };
  if (foundation) refreshCampaignNodeSnapshot(state);
  return {
    state,
    attackerId: attacker.id,
    defenderId: defender.id,
    extraAttackerId: extraAttacker.id,
    extraDefenderId: extraDefender.id,
    declinedId: declined.id,
  };
}

function step(state: GameState, action: GameAction): GameState {
  const result = apply(state, action);
  expect(result.error, action.type).toBeNull();
  return result.state;
}
function holder(state: GameState, id: string): Army {
  const result = state.armies.find((a) => a.id === id);
  expect(result, id).toBeDefined();
  return result!;
}
function roundTrip(state: GameState): GameState {
  const result = deserializeSave(serializeSave(state, 'Independent engagement review'));
  if (!result.ok) throw new Error(result.error);
  expect(result.save.state).toEqual(state);
  return result.save.state;
}
function ready(f: Fixture): GameState {
  let s = step(f.state, { type: 'engage', armyId: f.attackerId, targetId: f.defenderId });
  s = step(s, {
    type: 'engagementSelect',
    team: 'A',
    armyIds: [f.attackerId, f.extraAttackerId],
  });
  s = step(s, { type: 'engagementLock', team: 'A' });
  s = roundTrip(s);
  s = step(s, {
    type: 'engagementSelect',
    team: 'B',
    armyIds: [f.defenderId, f.extraDefenderId],
  });
  return step(s, { type: 'engagementLock', team: 'B' });
}
function deployed(f: Fixture): GameState {
  let s = step(ready(f), { type: 'startBattle' });
  s = step(s, { type: 'finishDeploy' });
  return step(s, { type: 'finishDeploy' });
}
function finishFoundationChoices(state: GameState): GameState {
  let s = state;
  for (let n = 0; n < 10; n++) {
    const capture = s.infrastructure?.capture.pending;
    if (capture) {
      for (const candidate of capture.candidates)
        s = step(s, { type: 'captureChoice', nodeId: candidate.node.id, outcome: 'none' });
      s = step(s, { type: 'captureCommit' });
    } else if (s.infrastructure?.garrisons?.pendingStationing)
      s = step(s, { type: 'stationingCommit' });
    else return s;
  }
  throw new Error('Foundation resolution did not finish');
}

for (const foundation of [false, true]) {
  describe(`independent engagement integration (${foundation ? 'foundation' : 'Classic'})`, () => {
    it('commits both prices and actual zones without relocating or exhausting additions or including declines', () => {
      const f = fixture(foundation);
      const unchanged = [f.extraAttackerId, f.extraDefenderId, f.declinedId].map((id) =>
        structuredClone(holder(f.state, id)),
      );
      const resources = structuredClone(f.state.infrastructure?.clock);
      const s = step(ready(f), { type: 'startBattle' });
      expect(s.cp).toEqual({ A: 53, B: 58 });
      expect(s.battle!.participationCosts).toEqual({ A: 7, B: 2 });
      for (const army of unchanged) expect(holder(s, army.id)).toEqual(army);
      expect(s.battle!.units.map((u) => u.holderId)).not.toContain(f.declinedId);
      const ctx = contextFor(s);
      const zone = deploymentZone(ctx, s.battle!, 'A', f.extraAttackerId);
      expect(zone).toContain(holder(f.state, f.extraAttackerId).pos);
      expect(zone.every((key) => ctx.cells.has(key))).toBe(true);
      if (foundation) {
        expect(s.infrastructure!.capture.work.commandPoints).toEqual(s.cp);
        expect(s.infrastructure!.clock).toEqual(resources);
      }
      expect(validateGameState(s)).toEqual([]);
      roundTrip(s);
    });

    it('rejects a stale defender affordability failure before spending either side or publishing a battle', () => {
      const f = fixture(foundation);
      const s = ready(f);
      s.cp.B = 1;
      if (foundation) refreshCampaignNodeSnapshot(s);
      const before = structuredClone(s);
      const rejected = apply(s, { type: 'startBattle' });
      expect(rejected.error).toMatch(/CP|afford/i);
      expect(rejected.state).toBe(s);
      expect(s).toEqual(before);
      expect(s.phase).toBe('battle-pending');
      expect(s.battle).toBeNull();
    });

    it('keeps additional commanders and declined local presence intact through normal final-snapshot writeback', () => {
      const f = fixture(foundation);
      const originals = [f.extraAttackerId, f.extraDefenderId, f.declinedId].map((id) =>
        structuredClone(holder(f.state, id)),
      );
      let s = deployed(f);
      const unit = s.battle!.units.find((u) => u.holderId === f.extraAttackerId)!;
      unit.hp -= 1;
      unit.facing = 5;
      // The final combat snapshot is the input boundary under review, not a fabricated combat journey.
      s.battle!.phase = 'over';
      s.battle!.winner = 'B';
      s.battle!.endReason = 'Independent final-snapshot writeback fixture';
      s = finishFoundationChoices(step(s, { type: 'concludeBattle' }));
      for (const original of originals) {
        const actual = holder(s, original.id);
        expect({ pos: actual.pos, at: actual.at, movesLeft: actual.movesLeft }).toEqual({
          pos: original.pos,
          at: original.at,
          movesLeft: original.movesLeft,
        });
        expect(actual.units.map((u) => u.id)).toEqual(original.units.map((u) => u.id));
      }
      const restored = holder(s, f.extraAttackerId).units[0]!;
      expect(restored.hp).toBe(unit.hp);
      expect(restored.facing).toBe(5);
      expect(holder(s, f.declinedId)).toEqual(originals[2]);
      expect(s.cp).toEqual({ A: 53, B: 58 });
      if (foundation) expect(s.infrastructure!.capture.work.commandPoints).toEqual(s.cp);
      expect(validateGameState(s)).toEqual([]);
      roundTrip(s);
    });
  });
}

it('rejects using another commander zone for a primary unit, while that zone remains usable by its owner', () => {
  const f = fixture();
  let s = step(ready(f), { type: 'startBattle' });
  s = step(s, { type: 'finishDeploy' });
  const b = s.battle!;
  const ctx = contextFor(s);
  const primaryZone = new Set(deploymentZone(ctx, b, 'A', f.attackerId));
  const extraOnly = deploymentZone(ctx, b, 'A', f.extraAttackerId).find(
    (key) => !primaryZone.has(key) && !ctx.unitAt.has(key),
  );
  expect(extraOnly).toBeDefined();
  const primary = b.units.find((u) => u.holderId === f.attackerId)!;
  const extra = b.units.find((u) => u.holderId === f.extraAttackerId)!;
  const failed = apply(s, { type: 'deploy', unitId: primary.id, cell: extraOnly! });
  expect(failed.error).toMatch(/zone/i);
  expect(failed.state).toBe(s);
  s = step(s, { type: 'deploy', unitId: extra.id, cell: extraOnly! });
  expect(s.battle!.units.find((u) => u.id === extra.id)!.pos).toBe(extraOnly);
});

it.each([true, false])(
  'keeps declined hostile center presence distinct from unrelated field presence (onCenter=%s)',
  (onCenter) => {
    const f = fixture(true);
    const { world } = worldOf(f.state);
    const site = f.state.infrastructure!.sites.find((candidate) => candidate.homeTeam === 'B')!;
    const ann = site.annexSubHexes;
    for (const [id, cell] of [
      [f.attackerId, ann[0]],
      [f.defenderId, ann[1]],
      [f.extraAttackerId, ann[2]],
      [f.extraDefenderId, ann[3]],
      [f.declinedId, onCenter ? site.centerSubHex : ann[4]],
    ] as const)
      setHolderPos(world, holder(f.state, id), cell!);
    refreshCampaignNodeSnapshot(f.state);
    const declined = structuredClone(holder(f.state, f.declinedId));
    let s = step(ready(f), { type: 'startBattle' });
    const battle = s.battle!;
    const center = parseKey(site.centerSubHex);
    const elsewhere = [...contextFor(s).cells].filter(
      (cell) => hexDistance(parseKey(cell), center) > 2,
    );
    for (const unit of battle.units) unit.pos = elsewhere.shift()!;
    battle.units.find((unit) => unit.holderId === f.attackerId)!.pos = site.centerSubHex;
    // Actual final snapshot boundary: the participating attacker is on center,
    // while the independent declined holder is still physically there too.
    battle.phase = 'over';
    battle.winner = 'A';
    battle.endReason = 'Independent declined-center final-snapshot fixture';
    s = step(s, { type: 'concludeBattle' });
    expect(holder(s, f.declinedId)).toEqual(declined);
    const offered =
      s.infrastructure!.capture.pending?.candidates.map((candidate) => candidate.node.id) ?? [];
    if (onCenter) expect(offered).not.toContain(site.nodeId);
    else expect(offered).toContain(site.nodeId);
    expect(s.infrastructure!.capture.nodes.find((node) => node.id === site.nodeId)!.owner).toBe(
      'B',
    );
  },
);
