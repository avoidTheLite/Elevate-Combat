// Actual campaign/battle adapters for deliberate stationing and explicit free shots.
import { buildWorld } from '../grid.ts';
import { buildContext } from '../battleMap.ts';
import { previewAttack, resolveAttack } from '../combat.ts';
import type { AttackOutcome, AttackPreview } from '../combat.ts';
import { createRng } from '../rng.ts';
import { freeSubNear, setHolderPos } from '../strategic.ts';
import { checkVictory } from '../tactical.ts';
import { unitType } from '../units.ts';
import type { Army, ArmyUnit, Battle, BattleUnit, GameState, Team } from '../types.ts';
import {
  beginFreeShotBoundary,
  createFreeShotState,
  getFreeShotPrompt,
  openFreeShotCycle,
  resolveSelectedFreeShot,
  selectFreeShotTarget,
  validateFreeShotState,
} from './freeShots.ts';
import type { FreeShotFrame, FreeShotPrompt, FreeShotState, FreeShotTrigger } from './freeShots.ts';

export interface CampaignStationingCandidate {
  readonly unitId: string;
  readonly holderId: string;
  readonly label: string;
  readonly typeId: string;
  readonly hp: number;
  readonly subHex: string;
  readonly tileKind: 'road' | 'outpost' | 'fort';
  /** Missing only for pending selections saved before facing persistence was added. */
  readonly facing?: number;
}
export interface CampaignPendingStationing {
  readonly battleId: string;
  readonly winner: Team;
  readonly version: number;
  readonly candidates: readonly CampaignStationingCandidate[];
  readonly selectedUnitIds: readonly string[];
}
export interface CampaignGarrisonState {
  readonly freeShots: FreeShotState;
  readonly pendingStationing: CampaignPendingStationing | null;
  readonly completedStationingBattleIds: readonly string[];
}
export interface CampaignStationingTile {
  readonly subHex: string;
  readonly kind: 'road' | 'outpost';
}
export type CampaignGarrisonResult =
  | { readonly ok: true; readonly outcome?: AttackOutcome }
  | { readonly ok: false; readonly error: string };
export interface CampaignGarrisonTargetOption {
  readonly targetId: string;
  readonly label: string;
  readonly expectedDamage: number;
  readonly pDirect: number;
  readonly pSplash: number;
}
const failure = (error: string): CampaignGarrisonResult => ({ ok: false, error });
const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function runtime(state: GameState): CampaignGarrisonState | undefined {
  return state.infrastructure?.garrisons;
}
function writeRuntime(state: GameState, value: CampaignGarrisonState): void {
  if (!state.infrastructure) throw new Error('Campaign infrastructure is not enabled');
  state.infrastructure = { ...state.infrastructure, garrisons: value };
}
export function createCampaignGarrisonState(): CampaignGarrisonState {
  return {
    freeShots: createFreeShotState(),
    pendingStationing: null,
    completedStationingBattleIds: [],
  };
}

/** Freeze only manual-victory candidates before tactical positions are cleared. */
export function prepareCampaignStationing(
  state: GameState,
  battle: Battle,
  tiles: readonly CampaignStationingTile[],
): CampaignGarrisonResult {
  const data = runtime(state);
  if (!data) return failure('Campaign garrisons are not enabled');
  if (battle.phase !== 'over' || !battle.winner || state.battle?.id !== battle.id)
    return failure('Manual battle victory is required');
  if (data.completedStationingBattleIds.includes(battle.id)) return { ok: true };
  if (data.pendingStationing)
    return data.pendingStationing.battleId === battle.id
      ? { ok: true }
      : failure('Finish the pending stationing choices');
  const candidates: CampaignStationingCandidate[] = [];
  const seen = new Set<string>();
  for (const unit of battle.units) {
    if (unit.hp <= 0 || !unit.pos || unit.team !== battle.winner || unit.stationed) continue;
    const holder =
      state.armies.find((a) => a.id === unit.holderId && a.units.some((u) => u.id === unit.id)) ??
      state.armies.find((a) => a.units.some((u) => u.id === unit.id));
    if (!holder || holder.team !== battle.winner) return failure('Missing winning unit holder');
    const tileKind =
      (battle.forts[unit.pos] ?? 0) > 0
        ? 'fort'
        : tiles.find((tile) => tile.subHex === unit.pos)?.kind;
    if (!tileKind) continue;
    if (seen.has(unit.id)) return failure('Duplicate stationing candidate');
    seen.add(unit.id);
    candidates.push({
      unitId: unit.id,
      holderId: holder.id,
      label: unit.label,
      typeId: unit.typeId,
      hp: unit.hp,
      subHex: unit.pos,
      tileKind,
      facing: unit.facing,
    });
  }
  candidates.sort((a, b) => lexical(a.unitId, b.unitId));
  writeRuntime(state, {
    ...data,
    pendingStationing: candidates.length
      ? { battleId: battle.id, winner: battle.winner, version: 0, candidates, selectedUnitIds: [] }
      : null,
    completedStationingBattleIds: candidates.length
      ? data.completedStationingBattleIds
      : [...data.completedStationingBattleIds, battle.id],
  });
  return { ok: true };
}

export function toggleCampaignStationing(
  state: GameState,
  unitId: string,
  expectedVersion: number,
): CampaignGarrisonResult {
  const data = runtime(state);
  const pending = data?.pendingStationing;
  if (!data || !pending) return failure('No pending stationing choices');
  if (pending.version !== expectedVersion) return failure('Stationing choices changed');
  if (!pending.candidates.some((c) => c.unitId === unitId))
    return failure('Unit cannot be stationed here');
  const selected = pending.selectedUnitIds.includes(unitId)
    ? pending.selectedUnitIds.filter((id) => id !== unitId)
    : [...pending.selectedUnitIds, unitId].sort(lexical);
  writeRuntime(state, {
    ...data,
    pendingStationing: { ...pending, version: pending.version + 1, selectedUnitIds: selected },
  });
  return { ok: true };
}

/** Atomically detach selected survivors; existing forts need no new qualification. */
export function commitCampaignStationing(
  state: GameState,
  expectedVersion: number,
): CampaignGarrisonResult {
  const data = runtime(state);
  const pending = data?.pendingStationing;
  if (!data || !pending) return failure('No pending stationing choices');
  if (pending.version !== expectedVersion) return failure('Stationing choices changed');
  const world = buildWorld(state.settings.grid);
  const draft = structuredClone(state);
  const cells = new Set<string>();
  for (const id of pending.selectedUnitIds) {
    const candidate = pending.candidates.find((c) => c.unitId === id);
    const holder = draft.armies.find((a) => a.id === candidate?.holderId);
    const unit = holder?.units.find((u) => u.id === id);
    if (
      !candidate ||
      !holder ||
      !unit ||
      holder.team !== pending.winner ||
      unit.typeId !== candidate.typeId ||
      unit.hp !== candidate.hp ||
      candidate.hp <= 0 ||
      (candidate.facing !== undefined &&
        (!Number.isInteger(candidate.facing) || candidate.facing < 0 || candidate.facing > 5)) ||
      !world.subByKey.has(candidate.subHex) ||
      cells.has(candidate.subHex)
    )
      return failure('Stationing snapshot is no longer valid');
    if (
      draft.armies.some(
        (a) => a.kind === 'garrison' && a.pos === candidate.subHex && a.units.some((u) => u.hp > 0),
      )
    )
      return failure('This tile already has a garrison');
    cells.add(candidate.subHex);
    holder.units = holder.units.filter((u) => u.id !== id);
    draft.armies.push({
      id: `tile-garrison-${draft.nextId++}`,
      kind: 'garrison',
      building: 'temporary',
      team: pending.winner,
      pos: candidate.subHex,
      at: world.subByKey.get(candidate.subHex)!.main,
      movesLeft: 0,
      stationedFacing: candidate.facing ?? (pending.winner === 'A' ? 0 : 3),
      units: [{ ...unit, hp: candidate.hp }],
    });
  }
  draft.armies = draft.armies.filter((a) => a.kind !== 'commander' || a.units.length > 0);
  for (const commander of draft.armies.filter((a) => a.kind === 'commander' && cells.has(a.pos))) {
    const free = freeSubNear(draft, world, commander.pos, commander.at, commander.id);
    if (!free) return failure('No free position for the remaining commander');
    setHolderPos(world, commander, free);
  }
  state.armies = draft.armies;
  state.nextId = draft.nextId;
  writeRuntime(state, {
    ...data,
    pendingStationing: null,
    completedStationingBattleIds: [...data.completedStationingBattleIds, pending.battleId],
  });
  return { ok: true };
}

function battleUnit(holder: Army, unit: ArmyUnit): BattleUnit {
  const type = unitType(unit.typeId);
  return {
    id: unit.id,
    typeId: unit.typeId,
    label: unit.label,
    team: holder.team,
    hp: unit.hp,
    maxHp: type.hp,
    pos: holder.pos,
    facing:
      holder.building === 'temporary'
        ? (holder.stationedFacing ?? (holder.team === 'A' ? 0 : 3))
        : holder.team === 'A'
          ? 0
          : 3,
    mp: 0,
    moved: false,
    movedDist: 0,
    acted: false,
    deployed: type.placementCategory === 'combat_fixed',
    suppressed: false,
    exposed: false,
    firstStrikeUsed: false,
    holderId: holder.id,
    stationed: holder.building === 'temporary',
  };
}
function strategicBattle(state: GameState, shooterId: string): Battle | null {
  const shooter = state.armies.find(
    (a) => a.building === 'temporary' && a.units.some((u) => u.id === shooterId && u.hp > 0),
  );
  if (!shooter) return null;
  const world = buildWorld(state.settings.grid);
  return {
    id: `free-shot:${shooterId}`,
    era: state.settings.era,
    attacker: shooter.team,
    defender: shooter.team === 'A' ? 'B' : 'A',
    attackerArmyId: shooter.id,
    defenderArmyId: 'packed-target',
    contested: shooter.at,
    origin: shooter.at,
    mains: world.mains.map((m) => m.key),
    phase: 'combat',
    deployTeam: shooter.team,
    active: shooter.team,
    round: 0,
    maxRounds: state.settings.battleRounds,
    units: state.armies.flatMap((a) =>
      a.units.filter((u) => u.hp > 0).map((u) => battleUnit(a, u)),
    ),
    forts: { ...state.forts },
    warningTurns: 0,
    warnedPlacements: 0,
    warnedRange: 0,
    objective: { kind: 'hold_contested', captureRadius: 0, extractionAtOrigin: false },
    extracted: false,
    log: [],
    winner: null,
    endReason: null,
  };
}
function tacticalPreviewBattle(state: GameState, shooterId: string): Battle | null {
  if (!state.battle) return null;
  const battle = structuredClone(state.battle);
  const shooter = battle.units.find((u) => u.id === shooterId && u.stationed && u.hp > 0 && u.pos);
  if (!shooter) return null;
  battle.active = shooter.team;
  shooter.acted = false;
  return battle;
}
function option(
  targetId: string,
  label: string,
  previews: readonly AttackPreview[],
): CampaignGarrisonTargetOption {
  return {
    targetId,
    label,
    expectedDamage: previews.reduce((n, p) => n + p.expectedDamage, 0) / previews.length,
    pDirect: previews.reduce((n, p) => n + p.pDirect, 0) / previews.length,
    pSplash: previews.reduce((n, p) => n + p.pSplash, 0) / previews.length,
  };
}
export function campaignGarrisonTargetOptions(
  state: GameState,
  shooterId: string,
  trigger: FreeShotTrigger,
): CampaignGarrisonTargetOption[] {
  const battle =
    trigger === 'tactical-after-deployment'
      ? tacticalPreviewBattle(state, shooterId)
      : strategicBattle(state, shooterId);
  if (!battle) return [];
  const shooter = battle.units.find((u) => u.id === shooterId)!;
  const ctx = buildContext(state.settings, battle);
  if (trigger === 'tactical-after-deployment')
    return battle.units
      .filter((u) => u.hp > 0 && u.pos && u.team !== shooter.team)
      .flatMap((u) => {
        const preview = previewAttack(ctx, battle, shooter, u.pos!);
        return preview.legal ? [option(u.id, u.label, [preview])] : [];
      })
      .sort((a, b) => lexical(a.targetId, b.targetId));
  return state.armies
    .filter(
      (a) => a.kind === 'commander' && a.team !== shooter.team && a.units.some((u) => u.hp > 0),
    )
    .flatMap((army) => {
      const previews = army.units
        .filter((u) => u.hp > 0)
        .sort((a, b) => lexical(a.id, b.id))
        .flatMap((unit) => {
          const target = battle.units.find((u) => u.id === unit.id)!;
          ctx.unitAt.set(army.pos, target);
          const preview = previewAttack(ctx, battle, shooter, army.pos);
          return preview.legal ? [preview] : [];
        });
      return previews.length
        ? [option(army.id, `${army.team} commander ${army.id}`, previews)]
        : [];
    })
    .sort((a, b) => lexical(a.targetId, b.targetId));
}

function frameFor(state: GameState, trigger: FreeShotTrigger, revision: number): FreeShotFrame {
  const actors: FreeShotFrame['actors'][number][] =
    trigger === 'tactical-after-deployment'
      ? (state.battle?.units ?? [])
          .filter((u) => u.pos !== null)
          .map((u) => ({
            id: u.id,
            team: u.team,
            subHex: u.pos!,
            alive: u.hp > 0,
            kind: u.stationed ? ('stationed-unit' as const) : ('unit' as const),
            normalActions: { mp: u.mp, acted: u.acted, moved: u.moved },
          }))
      : state.armies.flatMap<FreeShotFrame['actors'][number]>((a) =>
          a.building === 'temporary'
            ? a.units.map((u) => ({
                id: u.id,
                team: a.team,
                subHex: a.pos,
                alive: u.hp > 0,
                kind: 'stationed-unit' as const,
                normalActions: null,
              }))
            : [
                {
                  id: a.id,
                  team: a.team,
                  subHex: a.pos,
                  alive: a.units.some((u) => u.hp > 0),
                  kind: a.kind === 'commander' ? ('commander' as const) : ('unit' as const),
                  normalActions: null,
                },
              ],
        );
  // Army writeback removes dead persistent units. Keep only their dead facts in
  // this in-progress queue, never zero-HP units in the actual save army roster.
  for (const previous of runtime(state)?.freeShots.pending?.frame.actors ?? []) {
    if (!actors.some((a) => a.id === previous.id)) actors.push({ ...previous, alive: false });
  }
  return {
    revision,
    rngState: state.rng,
    actors: [...actors].sort((a, b) => lexical(a.id, b.id)),
    legalTargets: actors
      .filter((a) => a.alive && a.kind === 'stationed-unit')
      .flatMap((a) =>
        campaignGarrisonTargetOptions(state, a.id, trigger).map((target) => ({
          shooterId: a.id,
          targetId: target.targetId,
        })),
      )
      .sort((a, b) => lexical(a.shooterId, b.shooterId) || lexical(a.targetId, b.targetId)),
  };
}
function factsKey(frame: FreeShotFrame): string {
  return JSON.stringify([
    frame.revision,
    frame.rngState,
    [...frame.actors]
      .sort((a, b) => lexical(a.id, b.id))
      .map((a) => [
        a.id,
        a.team,
        a.subHex,
        a.alive,
        a.kind,
        a.normalActions === null
          ? null
          : [a.normalActions.mp, a.normalActions.acted, a.normalActions.moved],
      ]),
    [...frame.legalTargets].sort(
      (a, b) => lexical(a.shooterId, b.shooterId) || lexical(a.targetId, b.targetId),
    ),
  ]);
}
export function openCampaignGarrisonCycle(
  state: GameState,
  team: Team,
  ownerCycleId: string,
): CampaignGarrisonResult {
  const data = runtime(state);
  if (!data) return failure('Campaign garrisons are not enabled');
  const existing = data.freeShots.cycles.find(
    (c) => c.request.team === team && c.request.ownerCycleId === ownerCycleId,
  );
  const result = openFreeShotCycle(
    data.freeShots,
    existing?.request ?? { expectedVersion: data.freeShots.version, team, ownerCycleId },
  );
  if (!result.ok) return failure(result.reason);
  writeRuntime(state, { ...data, freeShots: result.state });
  return { ok: true };
}
export function beginCampaignFreeShots(
  state: GameState,
  trigger: FreeShotTrigger,
  strategicOwner?: Team,
): CampaignGarrisonResult {
  const data = runtime(state);
  if (!data) return failure('Campaign garrisons are not enabled');
  if (trigger === 'tactical-after-deployment' && (!state.battle || state.battle.phase !== 'combat'))
    return failure('Both sides must finish deployment');
  const cycle = data.freeShots.cycles
    .filter((c) => c.request.team === strategicOwner)
    .sort((a, b) => b.openedVersion - a.openedVersion)[0];
  const boundaryId =
    trigger === 'tactical-after-deployment'
      ? `deployment:${state.battle!.id}`
      : `owner-start:${strategicOwner}:${cycle?.request.ownerCycleId}`;
  if (data.freeShots.boundaries.some((b) => b.request.boundaryId === boundaryId))
    return { ok: true };
  const result = beginFreeShotBoundary(
    data.freeShots,
    {
      expectedVersion: data.freeShots.version,
      boundaryId,
      trigger,
      strategicOwner: trigger === 'strategic-after-income' ? (strategicOwner ?? null) : null,
    },
    frameFor(state, trigger, 0),
  );
  if (!result.ok) return failure(result.reason);
  writeRuntime(state, { ...data, freeShots: result.state });
  return { ok: true };
}
export function campaignFreeShotPrompt(state: GameState): FreeShotPrompt {
  const data = runtime(state);
  return data ? getFreeShotPrompt(data.freeShots) : { ok: true, status: 'complete' };
}
export function selectCampaignFreeShotTarget(
  state: GameState,
  targetId: string,
): CampaignGarrisonResult {
  const data = runtime(state);
  const prompt = campaignFreeShotPrompt(state);
  if (!data || !prompt.ok || prompt.status === 'complete') return failure('No pending free shot');
  const result = selectFreeShotTarget(data.freeShots, {
    requestId: `target:${prompt.boundaryId}:${prompt.shooterId}:${prompt.ownerCycleId}`,
    expectedVersion: data.freeShots.version,
    boundaryId: prompt.boundaryId,
    team: prompt.team,
    ownerCycleId: prompt.ownerCycleId,
    shooterId: prompt.shooterId,
    targetId,
  });
  if (!result.ok) return failure(result.reason);
  writeRuntime(state, { ...data, freeShots: result.state });
  return { ok: true };
}

export function resolveCampaignFreeShot(state: GameState): CampaignGarrisonResult {
  const data = runtime(state);
  const prompt = campaignFreeShotPrompt(state);
  if (
    !data ||
    !prompt.ok ||
    prompt.status !== 'selected' ||
    !prompt.selection ||
    !data.freeShots.pending
  )
    return failure('Choose a free-shot target first');
  const before = data.freeShots.pending.frame;
  if (factsKey(frameFor(state, prompt.trigger, before.revision)) !== factsKey(before))
    return failure('Live free-shot facts changed');
  let draft: GameState | null = null;
  let attackOutcome: AttackOutcome | undefined;
  const result = resolveSelectedFreeShot(
    data.freeShots,
    {
      requestId: `resolve:${prompt.selection.request.requestId}`,
      expectedVersion: data.freeShots.version,
      selectionId: prompt.selection.request.requestId,
    },
    ({ frame, selection }) => {
      draft = structuredClone(state);
      const random = createRng(frame.rngState);
      let battle: Battle;
      let targetKey: string;
      let packedUnitIds: string[] = [];
      if (prompt.trigger === 'tactical-after-deployment') {
        if (!draft.battle) return { ok: false, reason: 'No tactical battle' };
        battle = draft.battle;
        const target = battle.units.find(
          (u) => u.id === selection.request.targetId && u.hp > 0 && u.pos,
        );
        if (!target) return { ok: false, reason: 'Target is no longer present' };
        targetKey = target.pos!;
      } else {
        const proxy = strategicBattle(draft, selection.request.shooterId);
        if (!proxy) return { ok: false, reason: 'No stationed shooter' };
        battle = proxy;
        const commander = draft.armies.find(
          (a) => a.id === selection.request.targetId && a.kind === 'commander',
        );
        if (!commander) return { ok: false, reason: 'No target commander' };
        targetKey = commander.pos;
        packedUnitIds = draft.armies
          .filter((a) => a.building !== 'temporary')
          .flatMap((a) => a.units.filter((u) => u.hp > 0).map((u) => u.id));
      }
      const shooter = battle.units.find((u) => u.id === selection.request.shooterId)!;
      const oldActive = battle.active;
      const actions = new Map(
        battle.units.map((u) => [
          u.id,
          { mp: u.mp, acted: u.acted, moved: u.moved, movedDist: u.movedDist },
        ]),
      );
      battle.active = shooter.team;
      shooter.acted = false;
      const ctx = buildContext(draft.settings, battle);
      if (prompt.trigger === 'strategic-after-income') {
        const army = draft.armies.find((a) => a.id === selection.request.targetId)!;
        const candidates = army.units
          .filter((u) => u.hp > 0)
          .sort((a, b) => lexical(a.id, b.id))
          .map((u) => battle.units.find((b) => b.id === u.id)!)
          .filter((unit) => {
            ctx.unitAt.set(targetKey, unit);
            return previewAttack(ctx, battle, shooter, targetKey).legal;
          });
        if (!candidates.length) return { ok: false, reason: 'No legal packed unit target' };
        // No attack-priority subsystem exists today; use the approved seeded fallback.
        ctx.unitAt.set(targetKey, random.pick(candidates));
      }
      const attack = resolveAttack(ctx, random, battle, shooter, targetKey, { packedUnitIds });
      if ('error' in attack) return { ok: false, reason: attack.error };
      attackOutcome = attack;
      for (const unit of battle.units) Object.assign(unit, actions.get(unit.id));
      battle.active = oldActive;
      draft.rng = random.state();
      if (prompt.trigger === 'strategic-after-income') {
        const health = new Map(battle.units.map((u) => [u.id, u.hp]));
        for (const army of draft.armies) {
          army.units = army.units
            .map((u) => ({ ...u, hp: health.get(u.id) ?? u.hp }))
            .filter((u) => u.hp > 0);
          if (army.building === 'temporary' && army.units.length === 1) {
            const final = battle.units.find((unit) => unit.id === army.units[0].id);
            if (final) army.stationedFacing = final.facing;
          }
        }
        draft.armies = draft.armies.filter(
          (a) => a.units.length > 0 || (a.kind === 'garrison' && a.building !== 'temporary'),
        );
        draft.forts = { ...battle.forts };
      }
      return {
        ok: true,
        outcomeId: `attack:${selection.request.requestId}`,
        frame: frameFor(draft, prompt.trigger, frame.revision + 1),
      };
    },
  );
  if (!result.ok || !draft) return failure(result.ok ? 'No attack result' : result.reason);
  const completed = draft as GameState;
  state.rng = completed.rng;
  state.battle = completed.battle;
  state.armies = completed.armies;
  state.forts = completed.forts;
  writeRuntime(state, { ...data, freeShots: result.state });
  if (!result.state.pending && state.battle) checkVictory(state.battle);
  return { ok: true, ...(attackOutcome ? { outcome: attackOutcome } : {}) };
}

/** Actual save cross-references; never asks for an engineer to reuse a saved fort. */
export function validateCampaignGarrisonState(state: GameState): string | null {
  const data = runtime(state);
  if (!data) return null;
  try {
    const invalid = validateFreeShotState(data.freeShots);
    if (invalid) return invalid;
    if (
      !Array.isArray(data.completedStationingBattleIds) ||
      new Set(data.completedStationingBattleIds).size !== data.completedStationingBattleIds.length
    )
      return 'Invalid stationing completion history';
    for (const id of data.completedStationingBattleIds)
      if (typeof id !== 'string' || !id.trim()) return 'Invalid stationing completion history';
    const world = buildWorld(state.settings.grid);
    const positions = new Set<string>();
    for (const holder of state.armies.filter((a) => a.building === 'temporary')) {
      if (
        holder.kind !== 'garrison' ||
        holder.units.length !== 1 ||
        !Number.isFinite(holder.units[0].hp) ||
        holder.units[0].hp <= 0 ||
        holder.movesLeft !== 0 ||
        (holder.stationedFacing !== undefined &&
          (!Number.isInteger(holder.stationedFacing) ||
            holder.stationedFacing < 0 ||
            holder.stationedFacing > 5)) ||
        world.subByKey.get(holder.pos)?.main !== holder.at ||
        positions.has(holder.pos)
      )
        return 'Invalid temporary garrison';
      positions.add(holder.pos);
    }
    const pending = data.pendingStationing;
    if (pending !== null) {
      if (
        !pending ||
        typeof pending.battleId !== 'string' ||
        !pending.battleId.trim() ||
        !Number.isSafeInteger(pending.version) ||
        pending.version < 0 ||
        !['A', 'B'].includes(pending.winner) ||
        !Array.isArray(pending.candidates) ||
        !Array.isArray(pending.selectedUnitIds) ||
        new Set(pending.candidates.map((c) => c.unitId)).size !== pending.candidates.length ||
        new Set(pending.selectedUnitIds).size !== pending.selectedUnitIds.length ||
        data.completedStationingBattleIds.includes(pending.battleId)
      )
        return 'Invalid pending stationing';
      for (const candidate of pending.candidates) {
        const holder = state.armies.find((a) => a.id === candidate.holderId);
        const unit = holder?.units.find((u) => u.id === candidate.unitId);
        if (
          !unit ||
          holder!.team !== pending.winner ||
          unit.typeId !== candidate.typeId ||
          unit.hp !== candidate.hp ||
          candidate.hp <= 0 ||
          (candidate.facing !== undefined &&
            (!Number.isInteger(candidate.facing) ||
              candidate.facing < 0 ||
              candidate.facing > 5 ||
              state.battle?.units.find((unit) => unit.id === candidate.unitId)?.facing !==
                candidate.facing)) ||
          unit.label !== candidate.label ||
          !world.subByKey.has(candidate.subHex) ||
          !['road', 'outpost', 'fort'].includes(candidate.tileKind)
        )
          return 'Stationing candidate does not match a survivor';
      }
      if (pending.selectedUnitIds.some((id) => !pending.candidates.some((c) => c.unitId === id)))
        return 'Unknown selected stationing unit';
      if (
        state.battle?.id !== pending.battleId &&
        state.infrastructure?.clock?.resolvingBattle?.id !== pending.battleId
      )
        return 'Pending stationing lost its final battle';
    }
    for (const unit of state.battle?.units ?? []) {
      if (!unit.stationed) continue;
      if (
        unit.hp <= 0 &&
        state.battle?.phase === 'over' &&
        state.infrastructure?.clock?.resolvingBattle?.id === state.battle.id
      )
        continue;
      const holder = state.armies.find((a) => a.id === unit.holderId && a.building === 'temporary');
      if (
        !holder ||
        holder.team !== unit.team ||
        holder.pos !== unit.pos ||
        !holder.units.some((u) => u.id === unit.id)
      )
        return 'Stationed battle unit lost its holder';
    }
    if (data.freeShots.pending) {
      const prompt = getFreeShotPrompt(data.freeShots);
      if (
        !prompt.ok ||
        prompt.status === 'complete' ||
        factsKey(frameFor(state, prompt.trigger, data.freeShots.pending.frame.revision)) !==
          factsKey(data.freeShots.pending.frame)
      )
        return 'Saved free-shot facts do not match live state';
    }
    return null;
  } catch {
    return 'Invalid campaign garrison state';
  }
}
