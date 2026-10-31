import { describe, expect, it } from 'vitest';
import { apply } from '../actions.ts';
import type { GameAction } from '../actions.ts';
import { mainNeighbors } from '../grid.ts';
import type { World } from '../grid.ts';
import { hexDistance, parseKey } from '../hex.ts';
import { deserializeSave, serializeSave, validateGameState } from '../save.ts';
import { createGame, defaultSettings, makeUnit, setHolderPos, worldOf } from '../strategic.ts';
import { createBattle } from '../tactical.ts';
import type { Army, GameState, Team } from '../types.ts';
import { campaignBuildingData, refreshCampaignNodeSnapshot } from './campaignNodes.ts';
import type { CampaignNodeSite } from './campaignNodes.ts';
import { syncCampaignClaims } from './campaign.ts';
import { applyCampaignWithdrawal, validateCampaignWithdrawal } from './campaignWithdrawal.ts';
import { createFoundationPlaytestConfiguration } from './playtestProfile.ts';

function step(state: GameState, action: GameAction): GameState {
  const result = apply(state, action);
  expect(result.error, `${action.type}: ${result.error}`).toBeNull();
  expect(validateGameState(result.state)).toEqual([]);
  return result.state;
}
function resume(state: GameState): GameState {
  expect(validateGameState(state)).toEqual([]);
  const result = deserializeSave(
    serializeSave(state, 'Withdrawal boundary', '2026-10-31T12:00:00.000Z'),
  );
  if (!result.ok) throw new Error(result.error);
  expect(result.save.state).toEqual(state);
  return result.save.state;
}

function fixture(options: { withdrawing: Team; regular?: 'hq' | 'node'; fallback?: boolean }): {
  state: GameState;
  world: World;
  origin: string;
  target: string;
  armyId: string;
  defenderId: string;
  defenderUnitIds: string[];
  guardId: string;
  guardPos: string;
  guardUnit: Army['units'][number];
  centerUnitId: string;
  site: CampaignNodeSite;
  friendly: string | null;
} {
  const state = createGame({
    ...defaultSettings(),
    seed: 1,
    fog: false,
    controllers: { A: 'human', B: 'human' },
    grid: { mainCols: 3, mainRows: 3, subRadius: 2 },
    infrastructure: createFoundationPlaytestConfiguration(7, 3),
  });
  state.cp = { A: 100, B: 100 };
  const { world } = worldOf(state);
  const target = state.hq.B;
  const origin = mainNeighbors(world, target).find((main) => main.key !== state.hq.A)!.key;
  const a = state.armies.find((holder) => holder.team === 'A' && holder.kind === 'commander')!;
  setHolderPos(world, a, world.mainByKey.get(origin)!.subKeys[0]);
  let defender = state.armies.find((holder) => holder.team === 'B' && holder.kind === 'commander')!;
  const site = state.infrastructure!.sites.find((candidate) => candidate.homeTeam === 'B')!;
  if (options.regular) {
    defender = state.armies.find((holder) => holder.team === 'B' && holder.building === 'hq')!;
    defender.units.push(
      makeUnit(state, 'B', 'ww2_rifle_infantry'),
      makeUnit(state, 'B', 'ww2_machine_gun'),
    );
    if (options.regular === 'node') {
      defender.building = 'node';
      defender.nodeId = site.nodeId;
    }
  }
  const guardPos = world.mainByKey
    .get(target)!
    .subKeys.find((key) => !state.armies.some((holder) => holder.pos === key))!;
  state.forts[guardPos] = 2;
  const guard: Army = {
    id: 'fixed-withdrawing-side-guard',
    team: 'B',
    kind: 'garrison',
    building: 'temporary',
    pos: guardPos,
    at: target,
    units: [makeUnit(state, 'B', 'ww2_rifle_infantry')],
    movesLeft: 0,
  };
  state.armies.push(guard);
  let friendly: string | null = null;
  if (options.fallback) {
    friendly = mainNeighbors(world, target).find(
      (main) => main.key !== origin && main.key !== state.hq.A,
    )!.key;
    const f = state.infrastructure!;
    state.infrastructure = {
      ...f,
      capture: {
        ...f.capture,
        nodes: f.capture.nodes.map((node) =>
          node.mainHex === friendly
            ? {
                ...node,
                owner: 'B',
                buildings: node.buildings.map((building) => ({
                  ...building,
                  data: { ...campaignBuildingData(building), active: true },
                })),
              }
            : node,
        ),
      },
    };
  }
  syncCampaignClaims(state);
  refreshCampaignNodeSnapshot(state);
  const battle = createBattle(state, a, defender, origin, target, world);
  battle.phase = 'combat';
  battle.round = 1;
  battle.active = options.withdrawing;
  const cells = battle.mains.flatMap((key) => world.mainByKey.get(key)!.subKeys);
  const occupied = new Set(battle.units.filter((unit) => unit.stationed).map((unit) => unit.pos));
  const centerUnit = battle.units.find((unit) => unit.team === 'A')!;
  centerUnit.pos = site.centerSubHex;
  occupied.add(centerUnit.pos);
  let featured = false;
  for (const unit of battle.units) {
    if (unit.stationed || unit.id === centerUnit.id) continue;
    if (options.withdrawing === 'A' && unit.team === 'B' && friendly && !featured) {
      unit.pos = state.infrastructure!.sites.find(
        (candidate) => candidate.mainHex === friendly,
      )!.centerSubHex;
      occupied.add(unit.pos);
      featured = true;
      continue;
    }
    const pos = cells.find(
      (key) =>
        !occupied.has(key) &&
        !(battle.forts[key] ?? 0) &&
        !state.infrastructure!.sites.some((candidate) => candidate.centerSubHex === key) &&
        hexDistance(parseKey(key), parseKey(site.centerSubHex)) > 1,
    )!;
    unit.pos = pos;
    occupied.add(pos);
  }
  state.battle = battle;
  state.phase = 'battle';
  state.pending = null;
  return {
    state,
    world,
    origin,
    target,
    armyId: a.id,
    defenderId: defender.id,
    defenderUnitIds: defender.units.map((unit) => unit.id),
    guardId: guard.id,
    guardPos,
    guardUnit: structuredClone(guard.units[0]),
    centerUnitId: centerUnit.id,
    site,
    friendly,
  };
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: explicit withdrawal before capture facts', () => {
  it('returns an actual withdrawing attacker to origin and refuses its historical center capture', () => {
    const f = fixture({ withdrawing: 'A', fallback: true });
    let state = f.state;
    const hp = new Map(state.battle!.units.map((unit) => [unit.id, unit.hp]));
    const commandPoints = { ...state.cp };
    const workReceipts = structuredClone(state.infrastructure!.capture.work.receipts);
    const engineerSpending = structuredClone(state.infrastructure!.capture.work.engineerSpending);
    state = step(state, { type: 'retreat' });
    expect(state.battle!.withdrawnTeam).toBe('A');
    state = resume(state);
    state = step(state, { type: 'concludeBattle' });
    expect(state.infrastructure!.capture.pending).toBeNull();
    expect(state.infrastructure!.capture.receipts).toEqual([]);
    expect(state.cp).toEqual(commandPoints);
    expect(state.infrastructure!.capture.work.receipts).toEqual(workReceipts);
    expect(state.infrastructure!.capture.work.engineerSpending).toEqual(engineerSpending);
    expect(state.armies.find((holder) => holder.id === f.armyId)!.at).toBe(f.origin);
    expect(state.armies.find((holder) => holder.id === f.armyId)!.movesLeft).toBe(0);
    // A winning B survivor on its real outpost keeps the final battle available for save proof.
    expect(state.infrastructure!.garrisons!.pendingStationing).not.toBeNull();
    expect(state.battle!.departedUnitIds).toContain(f.centerUnitId);
    expect(state.battle!.campaignLostUnitIds).toEqual([]);
    expect(state.battle!.units.find((unit) => unit.id === f.centerUnitId)!.pos).toBe(
      f.site.centerSubHex,
    );
    expect(state.battle!.units.every((unit) => unit.hp === hp.get(unit.id))).toBe(true);
    state = resume(state);
    const before = JSON.stringify(state);
    expect(applyCampaignWithdrawal(state, f.world, state.battle!)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(JSON.stringify(state)).toBe(before);
    state = step(state, { type: 'stationingCommit' });
    expect(state.phase).toBe('strategic');
    expect(state.battle).toBeNull();
    expect(state.armies.find((holder) => holder.id === f.armyId)!.at).toBe(f.origin);
    resume(state);
  });

  it.each([true, false])(
    'uses existing defender adjacent fallback (available=%s), preserving fixed guards',
    (fallback) => {
      const f = fixture({ withdrawing: 'B', fallback });
      let state = f.state;
      state = step(state, { type: 'retreat' });
      state = step(state, { type: 'concludeBattle' });
      expect(
        state.infrastructure!.capture.pending?.candidates.map((candidate) => candidate.node.id),
      ).toContain(f.site.nodeId);
      const defender = state.armies.find((holder) => holder.id === f.defenderId);
      if (fallback) {
        expect(defender!.at).toBe(f.friendly);
        expect(defender!.movesLeft).toBe(0);
        expect(state.battle!.campaignLostUnitIds).toEqual([]);
      } else {
        expect(defender).toBeUndefined();
        expect(state.battle!.campaignLostUnitIds).toEqual([...f.defenderUnitIds].sort());
      }
      expect(state.battle!.departedUnitIds).toEqual([...f.defenderUnitIds].sort());
      expect(state.armies.find((holder) => holder.id === f.guardId)).toMatchObject({
        pos: f.guardPos,
        units: [f.guardUnit],
      });
      expect(state.battle!.departedUnitIds).not.toContain(f.guardUnit.id);
      resume(state);
    },
  );

  it('uses the inherited primary regular HQ overrun loss while leaving temporary guards intact', () => {
    const f = fixture({ withdrawing: 'B', regular: 'hq' });
    let state = f.state;
    const original = new Map(state.battle!.units.map((unit) => [unit.id, unit.hp]));
    state = step(state, { type: 'retreat' });
    state = resume(state);
    state = step(state, { type: 'concludeBattle' });
    expect(state.armies.find((holder) => holder.id === f.defenderId)!.units).toEqual([]);
    expect(state.battle!.campaignLostUnitIds).toEqual([...f.defenderUnitIds].sort());
    for (const id of f.defenderUnitIds)
      expect(state.battle!.units.find((unit) => unit.id === id)!.hp).toBe(original.get(id));
    expect(state.armies.find((holder) => holder.id === f.guardId)).toMatchObject({
      pos: f.guardPos,
      units: [f.guardUnit],
    });
    expect(
      state.infrastructure!.capture.pending?.candidates.map((candidate) => candidate.node.id),
    ).toContain(f.site.nodeId);
    expect(validateCampaignWithdrawal(state.battle!, state)).toBeNull();
    resume(state);
  });

  it('treats primary regular node garrisons the same as existing building garrisons', () => {
    const f = fixture({ withdrawing: 'B', regular: 'node' });
    // Isolate the shared helper; a node-bound holder on a Home HQ is intentionally not a save fixture.
    f.state.battle!.phase = 'over';
    f.state.battle!.winner = 'A';
    f.state.battle!.withdrawnTeam = 'B';
    const hp = JSON.stringify(f.state.battle!.units.map((unit) => unit.hp));
    expect(applyCampaignWithdrawal(f.state, f.world, f.state.battle!)).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(f.state.armies.find((holder) => holder.id === f.defenderId)!.units).toEqual([]);
    expect(f.state.battle!.campaignLostUnitIds).toEqual([...f.defenderUnitIds].sort());
    expect(JSON.stringify(f.state.battle!.units.map((unit) => unit.hp))).toBe(hp);
    expect(f.state.armies.find((holder) => holder.id === f.guardId)!.units).toEqual([f.guardUnit]);
  });

  it('does not infer withdrawal from an ordinary winner or EXTRACT and validates replay metadata', () => {
    const f = fixture({ withdrawing: 'A', fallback: true });
    const battle = f.state.battle!;
    battle.phase = 'over';
    battle.winner = 'B';
    const before = JSON.stringify(f.state);
    expect(applyCampaignWithdrawal(f.state, f.world, battle)).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(JSON.stringify(f.state)).toBe(before);
    battle.extracted = true;
    battle.winner = 'A';
    const extracted = JSON.stringify(f.state);
    expect(applyCampaignWithdrawal(f.state, f.world, battle)).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(JSON.stringify(f.state)).toBe(extracted);
    battle.extracted = false;
    battle.winner = 'B';
    battle.withdrawnTeam = 'A';
    expect(applyCampaignWithdrawal(f.state, f.world, battle).ok).toBe(true);
    const corrupted = { ...battle, campaignLostUnitIds: [f.guardUnit.id] };
    expect(validateCampaignWithdrawal(corrupted, f.state)).not.toBeNull();
    const omitted = { ...battle, departedUnitIds: [] };
    expect(validateCampaignWithdrawal(omitted, f.state)).not.toBeNull();
  });
});
