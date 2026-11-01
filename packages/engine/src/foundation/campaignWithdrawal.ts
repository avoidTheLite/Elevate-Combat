// GAMES-ELEVATE-CAMPAIGN-UC-002: existing withdrawal outcomes before capture proof.
import type { World } from '../grid.ts';
import { mainNeighbors } from '../grid.ts';
import { armiesAt, freeSubNear, setHolderPos } from '../strategic.ts';
import type { Battle, GameState, Team } from '../types.ts';

export type CampaignWithdrawalResult =
  | { readonly ok: true; readonly replayed: boolean }
  | { readonly ok: false; readonly error: string };
const isTeam = (value: unknown): value is Team => value === 'A' || value === 'B';
const sorted = (ids: readonly string[]): string[] => [...ids].sort();
const same = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** Pure save validation; never reconstructs a retreat, moves troops or removes survivors. */
export function validateCampaignWithdrawal(battle: Battle, state?: GameState): string | null {
  if (!battle || !Array.isArray(battle.units)) return 'Invalid withdrawal battle';
  const hasDeparted = battle.departedUnitIds !== undefined;
  const hasLost = battle.campaignLostUnitIds !== undefined;
  if (battle.withdrawnTeam === undefined)
    return hasDeparted || hasLost ? 'Withdrawal metadata needs an explicit withdrawn team' : null;
  if (
    !isTeam(battle.withdrawnTeam) ||
    battle.phase !== 'over' ||
    battle.extracted ||
    battle.winner !== (battle.withdrawnTeam === 'A' ? 'B' : 'A')
  )
    return 'Invalid explicit Retreat outcome';
  // Saving after Retreat but before campaign writeback is legitimate.
  if (!hasDeparted && !hasLost) return null;
  if (!Array.isArray(battle.departedUnitIds) || !Array.isArray(battle.campaignLostUnitIds))
    return 'Incomplete withdrawal metadata';
  const departed = battle.departedUnitIds;
  const lost = battle.campaignLostUnitIds;
  if (
    [departed, lost].some(
      (ids) =>
        Array.from(ids).some((id) => typeof id !== 'string' || !id.trim()) ||
        new Set(ids).size !== ids.length,
    )
  )
    return 'Invalid or duplicate withdrawal unit IDs';
  const expected = battle.units
    .filter((unit) => unit.team === battle.withdrawnTeam && unit.hp > 0 && !unit.stationed)
    .map((unit) => unit.id);
  if (!same(departed, expected) || lost.some((id) => !departed.includes(id)))
    return 'Withdrawal metadata differs from surviving mobile participants';
  if (state)
    for (const id of departed) {
      const holder = state.armies.find((army) => army.units.some((unit) => unit.id === id));
      if (
        lost.includes(id)
          ? holder !== undefined
          : !holder || holder.team !== battle.withdrawnTeam || holder.kind !== 'commander'
      ) {
        return 'Withdrawal metadata differs from persistent survivors/losses';
      }
    }
  return null;
}

/**
 * After final HP copy, before capture/stationing snapshots: inherit attacker origin return,
 * defender adjacent-friendly fallback-else-lost, and primary regular-garrison overrun losses.
 * Temporary guards stay fixed. Winner labels alone do not invoke this transformation.
 * EXTRACT remains its separate successful objective/return contract.
 */
export function applyCampaignWithdrawal(
  state: GameState,
  world: World,
  battle: Battle,
): CampaignWithdrawalResult {
  if (!battle || state.battle?.id !== battle.id)
    return { ok: false, error: 'Withdrawal needs the current finished battle' };
  const invalid = validateCampaignWithdrawal(battle);
  if (invalid) return { ok: false, error: invalid };
  if (battle.withdrawnTeam === undefined) return { ok: true, replayed: false };
  if (battle.departedUnitIds !== undefined) {
    const invalidReplay = validateCampaignWithdrawal(battle, state);
    return invalidReplay ? { ok: false, error: invalidReplay } : { ok: true, replayed: true };
  }
  const withdrawnTeam = battle.withdrawnTeam;
  const participants = new Map(
    battle.units
      .filter((unit) => unit.hp > 0 && unit.team === withdrawnTeam && !unit.stationed)
      .map((unit) => [unit.id, unit]),
  );
  const draft = structuredClone(state);
  const lost = new Set<string>();
  const covered = new Set<string>();
  for (const holder of draft.armies.filter(
    (army) => army.team === withdrawnTeam && army.units.some((unit) => participants.has(unit.id)),
  )) {
    const units = holder.units.filter((unit) => participants.has(unit.id));
    if (holder.units.some((unit) => !participants.has(unit.id)))
      return { ok: false, error: 'Withdrawal cannot transform nonparticipating troops' };
    if (holder.kind === 'garrison') {
      if (holder.building === 'temporary')
        return { ok: false, error: 'A temporary guard was incorrectly classified as mobile' };
      if (holder.id !== battle.defenderArmyId || !['hq', 'node'].includes(holder.building ?? ''))
        return { ok: false, error: 'Withdrawal has an unknown regular-garrison role' };
      for (const unit of units) {
        covered.add(unit.id);
        lost.add(unit.id);
      }
      holder.units = []; // Existing primary defending building overrun rule, no new HP formula.
      continue;
    }
    const recorded = battle.participants?.find((participant) => participant.armyId === holder.id);
    const originMain = recorded && !recorded.primary ? recorded.at : battle.origin;
    const originPosition = recorded && !recorded.primary ? recorded.pos : holder.pos;
    let destination: string | null | undefined;
    if (withdrawnTeam === battle.attacker) {
      destination = freeSubNear(draft, world, originPosition, originMain, holder.id);
      if (destination === null)
        return { ok: false, error: 'No free origin cell for the withdrawing attacker' };
    } else
      destination = mainNeighbors(
        world,
        recorded && !recorded.primary ? recorded.at : battle.contested,
      )
        .filter(
          (main) =>
            draft.hexes[main.key]?.owner === holder.team &&
            !armiesAt(draft, main.key).some((army) => army.team !== holder.team),
        )
        .map((main) => freeSubNear(draft, world, holder.pos, main.key, holder.id))
        .find((key) => key !== null);
    holder.movesLeft =
      recorded && !recorded.primary && destination === recorded.pos ? recorded.movesLeft : 0;
    for (const unit of units) covered.add(unit.id);
    if (destination !== undefined && destination !== null) setHolderPos(world, holder, destination);
    else {
      for (const unit of units) lost.add(unit.id);
      holder.units = [];
    }
  }
  if (!same([...covered], [...participants.keys()]))
    return { ok: false, error: 'Withdrawal lost its persistent participant holders' };
  draft.armies = draft.armies.filter(
    (holder) => holder.kind !== 'commander' || holder.units.length > 0,
  );
  const departedUnitIds = sorted([...participants.keys()]);
  const campaignLostUnitIds = sorted([...lost]);
  const invalidResult = validateCampaignWithdrawal(
    { ...battle, departedUnitIds, campaignLostUnitIds },
    draft,
  );
  if (invalidResult) return { ok: false, error: invalidResult };
  state.armies = draft.armies;
  battle.departedUnitIds = departedUnitIds;
  battle.campaignLostUnitIds = campaignLostUnitIds;
  return { ok: true, replayed: false };
}
