// GAMES-ELEVATE-CAMPAIGN-UC-002: shared player/AI pre-battle commitment.
// Reachability qualifies a commander; it never executes its qualifying path.

import { canEngage, commanderReach, engageOrigin } from './command.ts';
import { refreshCampaignNodeSnapshot } from './foundation/campaignNodes.ts';
import { attackCost, worldOf } from './strategic.ts';
import type { StratResult } from './strategic.ts';
import type {
  Army,
  BattleParticipant,
  EngagementProfile,
  GameState,
  PendingBattle,
  Team,
} from './types.ts';

export const EXPERIMENTAL_ENGAGEMENT_PROFILE: Readonly<EngagementProfile> = Object.freeze({
  profile: 'multi-commander-v1',
  attackBaseCp: 5,
  additionalAttackerCp: 2,
  additionalDefenderCp: 2,
});

/** Shared untrusted-settings validation; no initialization or mutation. */
export function validateEngagementProfile(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'engagement must be an experimental profile object';
  const p = value as Record<string, unknown>;
  const fields = ['profile', 'attackBaseCp', 'additionalAttackerCp', 'additionalDefenderCp'];
  if (Object.keys(p).some((key) => !fields.includes(key)))
    return 'engagement contains an unknown setting';
  if (p.profile !== 'multi-commander-v1') return 'Unknown engagement profile';
  for (const key of fields.slice(1)) {
    const n = p[key];
    if (!Number.isSafeInteger(n) || (n as number) < (key === 'attackBaseCp' ? 1 : 0))
      return `engagement.${key} must be a ${key === 'attackBaseCp' ? 'positive' : 'nonnegative'} whole CP price`;
  }
  return null;
}

export interface EngagementCandidate {
  armyId: string;
  alreadyPresent: boolean;
  /** Legal qualifying path length, not movement that participation will spend. */
  steps: number;
  reason?: string;
}

function primaryHolders(
  state: GameState,
  pending: PendingBattle,
): [Army | undefined, Army | undefined] {
  return [
    state.armies.find((army) => army.id === pending.attackerArmyId),
    state.armies.find((army) => army.id === pending.defenderArmyId),
  ];
}

/** Own commanders and eligibility reasons only; never discloses another side's choices. */
export function engagementCandidates(state: GameState, team: Team): EngagementCandidate[] {
  const p = state.pending;
  if (!p || !p.participation || !state.settings.engagement) return [];
  const [attacker, defender] = primaryHolders(state, p);
  if (!attacker || !defender) return [];
  const anchors = new Set([attacker.at, defender.at]);
  const { world } = worldOf(state);
  return state.armies
    .filter(
      (army) => army.team === team && army.kind === 'commander' && army.units.some((u) => u.hp > 0),
    )
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((army) => {
      if (anchors.has(army.at)) return { armyId: army.id, alreadyPresent: true, steps: 0 };
      let steps = Infinity;
      for (const [key, distance] of commanderReach(state, army)) {
        if (anchors.has(world.subByKey.get(key)?.main ?? '')) steps = Math.min(steps, distance);
      }
      return {
        armyId: army.id,
        alreadyPresent: false,
        steps,
        ...(Number.isFinite(steps)
          ? {}
          : { reason: 'Cannot reach either battle MainHex with remaining strategic movement' }),
      };
    });
}

/** Quote both pools. Legacy pending battles retain their saved unit-count formula. */
export function engagementCosts(state: GameState, pending: PendingBattle): Record<Team, number> {
  const costs: Record<Team, number> = { A: 0, B: 0 };
  const [attacker, defender] = primaryHolders(state, pending);
  if (!attacker || !defender) return costs;
  const profile = state.settings.engagement;
  if (profile && pending.participation) {
    costs[attacker.team] =
      profile.attackBaseCp +
      Math.max(0, pending.participation.attackerIds.length - 1) * profile.additionalAttackerCp;
    costs[defender.team] =
      Math.max(0, pending.participation.defenderIds.length - 1) * profile.additionalDefenderCp;
  } else costs[attacker.team] = attackCost(attacker);
  return costs;
}

function validateSelection(
  state: GameState,
  pending: PendingBattle,
  team: Team,
  ids: unknown,
): StratResult {
  const [attacker, defender] = primaryHolders(state, pending);
  if (!attacker || !defender) return { ok: false, error: 'Initial engagement holder is missing' };
  const primary = team === attacker.team ? attacker : defender;
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string') ||
    new Set(ids).size !== ids.length ||
    !ids.includes(primary.id)
  )
    return {
      ok: false,
      error: 'Select unique commander IDs including the mandatory initial holder',
    };
  const eligible = new Map(
    engagementCandidates(state, team).map((candidate) => [candidate.armyId, candidate]),
  );
  for (const id of ids) {
    const army = state.armies.find((candidate) => candidate.id === id);
    if (!army || army.team !== team || !army.units.some((unit) => unit.hp > 0))
      return { ok: false, error: 'Selected holder is missing, empty or belongs to the other side' };
    if (id === primary.id) continue;
    const candidate = eligible.get(id);
    if (!candidate || candidate.reason)
      return {
        ok: false,
        error: candidate?.reason ?? 'Only eligible additional commanders may join',
      };
  }
  return { ok: true };
}

/** Revalidate current primary visibility/range and both explicit rosters without any spend. */
export function validatePendingEngagement(state: GameState): StratResult {
  const p = state.pending;
  if (state.phase !== 'battle-pending' || !p) return { ok: false, error: 'No pending battle' };
  const profileError = validateEngagementProfile(state.settings.engagement);
  if (profileError) return { ok: false, error: profileError };
  const [attacker, defender] = primaryHolders(state, p);
  if (!attacker || !defender) return { ok: false, error: 'Initial engagement holder is missing' };
  const { world } = worldOf(state);
  if (!p.participation) {
    if (state.settings.engagement)
      return { ok: false, error: 'Experimental engagement is missing its participant selection' };
    // A legacy pending battle already established its engagement. Old saves and
    // scenario fixtures may retain historical origin/target coordinates even when
    // their current holder positions, movement or sight no longer open a new attack.
    // Loading/starting that fight must not replay today's initiation eligibility.
    if (
      attacker.id === defender.id ||
      attacker.team === defender.team ||
      !world.mainByKey.has(p.origin) ||
      !world.mainByKey.has(p.target)
    )
      return { ok: false, error: 'Invalid saved legacy engagement' };
    const cost = attackCost(attacker);
    if (!Number.isSafeInteger(state.cp[attacker.team]) || state.cp[attacker.team] < cost)
      return { ok: false, error: `Opening a deployment costs ${cost} CP` };
    return { ok: true };
  }
  if (!state.settings.engagement)
    return { ok: false, error: 'Participant selection requires its experimental profile' };
  const check = canEngage({ ...state, phase: 'strategic' }, attacker, defender);
  if (!check.ok) return check;
  if (p.target !== defender.at || p.origin !== engageOrigin(world, attacker, defender))
    return { ok: false, error: 'Initial engagement anchors changed' };
  if (!['attacker', 'defender', 'ready'].includes(p.participation.stage))
    return { ok: false, error: 'Invalid engagement selection stage' };
  for (const [team, ids] of [
    [attacker.team, p.participation.attackerIds],
    [defender.team, p.participation.defenderIds],
  ] as const) {
    const selection = validateSelection(state, p, team, ids);
    if (!selection.ok) return selection;
  }
  const costs = engagementCosts(state, p);
  for (const team of ['A', 'B'] as const) {
    if (!Number.isSafeInteger(state.cp[team]) || state.cp[team] < 0)
      return { ok: false, error: `${team} has an invalid CP pool` };
    if (!Number.isSafeInteger(costs[team]) || costs[team] < 0)
      return { ok: false, error: 'Participation CP total is invalid' };
    if (state.cp[team] < costs[team])
      return { ok: false, error: `${team} needs ${costs[team]} CP for its selected participants` };
  }
  return { ok: true };
}

/** Update a side's complete roster. A ready selection may be reopened without any refund/spend. */
export function selectEngagementParticipants(
  state: GameState,
  team: Team,
  armyIds: string[],
): StratResult {
  const p = state.pending;
  if (state.phase !== 'battle-pending' || !p?.participation)
    return { ok: false, error: 'No experimental engagement selection' };
  const profileError = validateEngagementProfile(state.settings.engagement);
  if (!state.settings.engagement || profileError)
    return {
      ok: false,
      error: profileError ?? 'Participant selection requires its experimental profile',
    };
  const [attacker, defender] = primaryHolders(state, p);
  if (!attacker || !defender || (team !== attacker.team && team !== defender.team))
    return { ok: false, error: 'Unknown engagement side' };
  const ownStage = team === attacker.team ? 'attacker' : 'defender';
  if (p.participation.stage !== ownStage && p.participation.stage !== 'ready')
    return { ok: false, error: 'This side cannot change the locked engagement selection' };
  const check = validateSelection(state, p, team, armyIds);
  if (!check.ok) return check;
  const field = ownStage === 'attacker' ? 'attackerIds' : 'defenderIds';
  const draft = structuredClone(p);
  draft.participation![field] = [...armyIds];
  const costs = engagementCosts(state, draft);
  if (state.cp[team] < costs[team])
    return { ok: false, error: `${team} needs ${costs[team]} CP for its selected participants` };
  // Reopening attacker choices invalidates the downstream defender choice as well.
  if (ownStage === 'attacker' && p.participation.stage === 'ready')
    p.participation.defenderIds = [defender.id];
  p.participation[field] = [...armyIds];
  p.participation.stage = ownStage;
  return { ok: true };
}

export function lockEngagementParticipants(state: GameState, team: Team): StratResult {
  const p = state.pending;
  if (state.phase !== 'battle-pending' || !p?.participation)
    return { ok: false, error: 'No experimental engagement selection' };
  const [attacker, defender] = primaryHolders(state, p);
  const expected = p.participation.stage === 'attacker' ? attacker?.team : defender?.team;
  if (p.participation.stage === 'ready' || team !== expected)
    return { ok: false, error: 'This side cannot lock the engagement selection now' };
  const check = validatePendingEngagement(state);
  if (!check.ok) return check;
  p.participation.stage = p.participation.stage === 'attacker' ? 'defender' : 'ready';
  return { ok: true };
}

/** Snapshot each actual holder, preserving the selected ordering and original roster lineage. */
export function engagementParticipantSnapshots(
  state: GameState,
  pending: PendingBattle,
): BattleParticipant[] {
  const ids = pending.participation
    ? [...pending.participation.attackerIds, ...pending.participation.defenderIds]
    : [pending.attackerArmyId, pending.defenderArmyId];
  return ids.map((id) => {
    const army = state.armies.find((holder) => holder.id === id);
    if (!army) throw new Error(`Missing engagement holder ${id}`);
    return {
      armyId: army.id,
      team: army.team,
      pos: army.pos,
      at: army.at,
      movesLeft: army.movesLeft,
      primary: id === pending.attackerArmyId || id === pending.defenderArmyId,
    };
  });
}

/** Charge once after the caller's deployment preflight; no commander moves or loses movement. */
export function commitEngagementCosts(state: GameState, pending: PendingBattle): StratResult {
  if (state.pending !== pending)
    return { ok: false, error: 'Commit requires the current pending engagement' };
  const check = validatePendingEngagement(state);
  if (!check.ok) return check;
  if (pending.participation && pending.participation.stage !== 'ready')
    return { ok: false, error: 'Both sides must lock their participants before commitment' };
  if (
    state.infrastructure &&
    (!Number.isSafeInteger(state.infrastructure.capture.version) ||
      state.infrastructure.capture.version >= Number.MAX_SAFE_INTEGER)
  )
    return { ok: false, error: 'Campaign snapshot version is exhausted' };
  const costs = engagementCosts(state, pending);
  state.cp = { A: state.cp.A - costs.A, B: state.cp.B - costs.B };
  if (state.infrastructure) refreshCampaignNodeSnapshot(state);
  return { ok: true };
}
