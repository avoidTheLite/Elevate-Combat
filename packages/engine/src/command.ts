// ── Command layer (V1.0): commanders on the sub-hex grid ─────────────────────
// Commanders walk the world's sub-cells (BFS, 1 step per cell, other holders and
// off-map cells block), engage enemy holders within `engageRange`, and swap units
// with nearby friendly holders. Garrisons sit in their building and never move.
// All distances come from `COMMAND` (strategic.ts) as functions of the sub-radius.

import type { HexKey } from './hex.ts';
import { hexDistance, hexKey, neighbors } from './hex.ts';
import type { World } from './grid.ts';
import { mainNeighbors } from './grid.ts';
import {
  COMMAND,
  ECONOMY,
  armiesAt,
  attackCost,
  capture,
  freeSubNear,
  logStrategic,
  newId,
  occupiedSubs,
  setHolderPos,
  visibleArmies,
  worldOf,
} from './strategic.ts';
import type { StratResult } from './strategic.ts';
import type { Army, GameState, TransferRule } from './types.ts';
import { TEAM_NAME } from './types.ts';

function findHolder(state: GameState, id: string): Army | undefined {
  return state.armies.find((a) => a.id === id);
}

function subDistance(world: World, a: HexKey, b: HexKey): number {
  const sa = world.subByKey.get(a);
  const sb = world.subByKey.get(b);
  return sa && sb ? hexDistance(sa.hex, sb.hex) : Infinity;
}

function ordersCheck(state: GameState, army: Army | undefined): StratResult {
  if (state.phase !== 'strategic') return { ok: false, error: 'Not in strategic phase' };
  if (!army) return { ok: false, error: 'No such holder' };
  if (army.team !== state.active) return { ok: false, error: 'Not your holder' };
  return { ok: true };
}

// ── Movement ──

/**
 * Sub-hexes a commander can reach this turn → step count (its own cell at 0).
 * BFS over world sub-cells; every other holder's cell blocks.
 */
export function commanderReach(state: GameState, army: Army): Map<HexKey, number> {
  const out = new Map<HexKey, number>([[army.pos, 0]]);
  if (army.kind !== 'commander' || army.movesLeft <= 0) return out;
  const { world } = worldOf(state);
  const blocked = occupiedSubs(state, army.id);
  let frontier = [army.pos];
  for (let step = 1; step <= army.movesLeft && frontier.length; step++) {
    const next: HexKey[] = [];
    for (const k of frontier) {
      for (const nb of neighbors(world.subByKey.get(k)!.hex)) {
        const nk = hexKey(nb);
        if (out.has(nk) || blocked.has(nk) || !world.subByKey.has(nk)) continue;
        out.set(nk, step);
        next.push(nk);
      }
    }
    frontier = next;
  }
  return out;
}

export function canMoveCommander(
  state: GameState,
  army: Army | undefined,
  dest: HexKey,
): StratResult & { steps?: number } {
  const chk = ordersCheck(state, army);
  if (!chk.ok) return chk;
  if (army!.kind !== 'commander') return { ok: false, error: 'Garrisons cannot move' };
  if (army!.movesLeft <= 0) return { ok: false, error: 'Commander has no moves left this turn' };
  const { world } = worldOf(state);
  if (!world.subByKey.has(dest)) return { ok: false, error: 'Off map' };
  if (dest === army!.pos) return { ok: false, error: 'Already there' };
  if (occupiedSubs(state, army!.id).has(dest)) return { ok: false, error: 'Cell is occupied' };
  const steps = commanderReach(state, army!).get(dest);
  if (steps === undefined) return { ok: false, error: 'Out of reach this turn' };
  return { ok: true, steps };
}

/**
 * Move a commander to a sub-hex. Only the destination main hex is captured
 * (passing through does not capture) — when it isn't ours and holds no enemy
 * holder with units.
 */
export function moveCommander(state: GameState, armyId: string, dest: HexKey): StratResult {
  const army = findHolder(state, armyId);
  const chk = canMoveCommander(state, army, dest);
  if (!chk.ok) return chk;
  const { world } = worldOf(state);
  setHolderPos(world, army!, dest);
  army!.movesLeft -= chk.steps!;
  if (
    state.hexes[army!.at]?.owner !== army!.team &&
    !armiesAt(state, army!.at).some((a) => a.team !== army!.team)
  )
    capture(state, world, army!.at, army!.team, false);
  return { ok: true };
}

// ── Engagement ──

/**
 * Battle origin for an engagement: the attacker's main hex, or — when both
 * holders share a main hex (or the attacker isn't adjacent) — the defender's
 * neighbouring main hex whose centre is nearest the attacker.
 */
export function engageOrigin(world: World, attacker: Army, defender: Army): HexKey {
  const adjacent = mainNeighbors(world, defender.at);
  if (adjacent.some((m) => m.key === attacker.at)) return attacker.at;
  const from = world.subByKey.get(attacker.pos)!.hex;
  return adjacent.reduce((best, m) =>
    hexDistance(m.center, from) < hexDistance(best.center, from) ? m : best,
  ).key;
}

export function canEngage(
  state: GameState,
  attacker: Army | undefined,
  target: Army | undefined,
): StratResult {
  const chk = ordersCheck(state, attacker);
  if (!chk.ok) return chk;
  const att = attacker!;
  if (att.kind !== 'commander') return { ok: false, error: 'Only commanders can attack' };
  if (att.movesLeft <= 0) return { ok: false, error: 'Commander has no moves left this turn' };
  if (!target || target.team === att.team) return { ok: false, error: 'No enemy target' };
  if (target.units.length === 0) return { ok: false, error: 'Target holds no units' };
  const { world } = worldOf(state);
  const range = COMMAND.engageRange(world.config.subRadius);
  if (subDistance(world, att.pos, target.pos) > range)
    return { ok: false, error: `Target is beyond engage range (${range})` };
  if (!visibleArmies(state, att.team).some((a) => a.id === target.id))
    return { ok: false, error: 'Target is not in sight' };
  if (state.cp[att.team] < attackCost(att))
    return { ok: false, error: `Opening a deployment costs ${attackCost(att)} CP` };
  return { ok: true };
}

/** Enemy holders this commander may engage right now. */
export function engageTargets(state: GameState, armyId: string): Army[] {
  const att = findHolder(state, armyId);
  return state.armies.filter((t) => canEngage(state, att, t).ok);
}

export function engage(state: GameState, armyId: string, targetId: string): StratResult {
  const att = findHolder(state, armyId);
  const def = findHolder(state, targetId);
  const chk = canEngage(state, att, def);
  if (!chk.ok) return chk;
  const { world } = worldOf(state);
  state.pending = {
    attackerArmyId: att!.id,
    defenderArmyId: def!.id,
    origin: engageOrigin(world, att!, def!),
    target: def!.at,
  };
  state.phase = 'battle-pending';
  logStrategic(state, `${TEAM_NAME[att!.team]} commander ${att!.id} assaults ${def!.at}!`);
  return { ok: true };
}

// ── Transfers ──

/** The active reassignment rule: `COMMAND.transferRule` with any settings override. */
export function transferRule(state: GameState): TransferRule {
  return {
    ...COMMAND.transferRule(state.settings.grid.subRadius),
    ...state.settings.transferRule,
  };
}

function capOf(army: Army): number {
  return army.kind === 'garrison' ? COMMAND.garrisonCap : ECONOMY.armyCap;
}

/**
 * May `count` units pass from one holder to another? Same active team, strategic
 * phase, within the transfer radius and/or same main hex (per `transferRule`),
 * and the receiver has room.
 */
export function canTransfer(
  state: GameState,
  from: Army | undefined,
  to: Army | undefined,
  count = 1,
): StratResult {
  const chk = ordersCheck(state, from);
  if (!chk.ok) return chk;
  if (!to || to.id === from!.id) return { ok: false, error: 'No receiving holder' };
  if (to.team !== from!.team) return { ok: false, error: 'Cannot transfer to the enemy' };
  const rule = transferRule(state);
  const { world } = worldOf(state);
  if (rule.sameMainHex && from!.at !== to.at)
    return { ok: false, error: 'Holders must share a main hex' };
  if (rule.radius !== null && subDistance(world, from!.pos, to.pos) > rule.radius)
    return { ok: false, error: `Holders must be within ${rule.radius} sub-hexes` };
  if (to.units.length + count > capOf(to))
    return { ok: false, error: `Receiver would exceed ${capOf(to)} units` };
  return { ok: true };
}

/** Friendly holders that could receive at least one unit from `holderId`. */
export function transferTargets(state: GameState, holderId: string): Army[] {
  const from = findHolder(state, holderId);
  return state.armies.filter((to) => canTransfer(state, from, to).ok);
}

function pickUnits(from: Army, unitIds: string[]): StratResult {
  if (unitIds.length === 0) return { ok: false, error: 'No units selected' };
  if (new Set(unitIds).size !== unitIds.length) return { ok: false, error: 'Duplicate units' };
  if (!unitIds.every((id) => from.units.some((u) => u.id === id)))
    return { ok: false, error: 'Unit not in this holder' };
  return { ok: true };
}

function removeEmpty(state: GameState, army: Army): void {
  if (army.kind === 'commander' && army.units.length === 0)
    state.armies = state.armies.filter((a) => a.id !== army.id);
}

/**
 * Move units between two holders. A receiving commander keeps min(movesLeft)
 * of both holders (garrisons count as 0). An emptied commander is removed.
 */
export function transferUnits(
  state: GameState,
  fromId: string,
  toId: string,
  unitIds: string[],
): StratResult {
  const from = findHolder(state, fromId);
  const to = findHolder(state, toId);
  const chk = canTransfer(state, from, to, unitIds.length);
  if (!chk.ok) return chk;
  const pick = pickUnits(from!, unitIds);
  if (!pick.ok) return pick;
  const moving = from!.units.filter((u) => unitIds.includes(u.id));
  from!.units = from!.units.filter((u) => !unitIds.includes(u.id));
  to!.units.push(...moving);
  if (to!.kind === 'commander') to!.movesLeft = Math.min(to!.movesLeft, from!.movesLeft);
  removeEmpty(state, from!);
  logStrategic(state, `${moving.length} unit(s) transferred ${from!.id} → ${to!.id}`);
  return { ok: true };
}

/**
 * Split units off a holder into a new commander on the nearest free sub-hex in
 * the same main hex. From a garrison the new commander has 0 moves this turn;
 * split from a commander it keeps the parent's movesLeft.
 */
export function formCommander(state: GameState, fromId: string, unitIds: string[]): StratResult {
  const from = findHolder(state, fromId);
  const chk = ordersCheck(state, from);
  if (!chk.ok) return chk;
  const pick = pickUnits(from!, unitIds);
  if (!pick.ok) return pick;
  if (from!.kind === 'commander' && unitIds.length >= from!.units.length)
    return { ok: false, error: 'Leave at least one unit with the commander' };
  if (unitIds.length > ECONOMY.armyCap)
    return { ok: false, error: `A commander holds at most ${ECONOMY.armyCap} units` };
  const { world } = worldOf(state);
  const cell = freeSubNear(state, world, from!.pos, from!.at);
  if (!cell) return { ok: false, error: 'No free cell in this main hex' };
  const army: Army = {
    id: newId(state, `${from!.team}army`),
    team: from!.team,
    kind: 'commander',
    pos: cell,
    at: from!.at,
    units: from!.units.filter((u) => unitIds.includes(u.id)),
    movesLeft: from!.kind === 'commander' ? from!.movesLeft : 0,
  };
  from!.units = from!.units.filter((u) => !unitIds.includes(u.id));
  state.armies.push(army);
  logStrategic(state, `New commander ${army.id} formed with ${army.units.length} unit(s)`);
  return { ok: true };
}

// ── V0.9 main-hex adapter ──

/**
 * Where `moveArmy` would go for a main-hex order: the nearest enemy holder there
 * if it is within engage range; otherwise a reachable cell — the one closest to
 * that enemy, or (no enemy) the cell of that main hex with the fewest steps
 * (ties → nearest its centre).
 */
function mainOrder(
  state: GameState,
  army: Army,
  dest: HexKey,
): { cell?: HexKey; target?: Army; error?: string } {
  const { world } = worldOf(state);
  const main = world.mainByKey.get(dest);
  if (!main) return { error: 'Off map' };
  const enemy = armiesAt(state, dest)
    .filter((a) => a.team !== army.team)
    .sort((a, b) => subDistance(world, army.pos, a.pos) - subDistance(world, army.pos, b.pos))[0];
  if (
    enemy &&
    subDistance(world, army.pos, enemy.pos) <= COMMAND.engageRange(world.config.subRadius)
  )
    return { target: enemy };
  if (!enemy && dest === army.at) return { error: 'Already in that hex' };
  const goal = enemy ? world.subByKey.get(enemy.pos)!.hex : main.center;
  const reach = commanderReach(state, army);
  const pool = enemy ? [...reach.keys()] : main.subKeys;
  let best: HexKey | undefined;
  let bestScore = Infinity;
  for (const k of pool) {
    const steps = reach.get(k);
    if (steps === undefined || steps === 0) continue;
    const d = hexDistance(world.subByKey.get(k)!.hex, goal);
    const score = enemy ? d * 100 + steps : steps * 100 + d;
    if (score < bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best ? { cell: best } : { error: 'Out of reach this turn' };
}

/** V0.9-style main-hex order check (UI highlight helper). */
export function canMoveTo(
  state: GameState,
  army: Army,
  dest: HexKey,
): StratResult & { battle?: boolean } {
  const chk = ordersCheck(state, army);
  if (!chk.ok) return chk;
  if (army.kind !== 'commander') return { ok: false, error: 'Garrisons cannot move' };
  if (army.movesLeft <= 0) return { ok: false, error: 'Commander has no moves left this turn' };
  const order = mainOrder(state, army, dest);
  if (order.error) return { ok: false, error: order.error };
  if (order.target) {
    const eng = canEngage(state, army, order.target);
    return eng.ok ? { ok: true, battle: true } : eng;
  }
  return { ok: true, battle: false };
}

/**
 * V0.9 adapter: order a commander into a main hex — engages the nearest enemy
 * holder there, otherwise moves to the nearest reachable free cell of that hex.
 */
export function moveArmy(state: GameState, armyId: string, dest: HexKey): StratResult {
  const army = findHolder(state, armyId);
  if (!army) return { ok: false, error: 'No such army' };
  const chk = canMoveTo(state, army, dest);
  if (!chk.ok) return chk;
  const order = mainOrder(state, army, dest);
  if (order.target) return engage(state, army.id, order.target.id);
  return moveCommander(state, army.id, order.cell!);
}
