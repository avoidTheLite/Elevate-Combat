// ── Tactical battle state machine ────────────────────────────────────────────
// Deployment (defender first, then attacker) → alternating side turns, attacker
// first, until one side is wiped out, retreats, or the round limit expires.

import type { HexKey } from './hex.ts';
import { directionTo, hexDistance, parseKey } from './hex.ts';
import type { World } from './grid.ts';
import { mainNeighbors } from './grid.ts';
import type { BattleContext } from './battleMap.ts';
import { buildContext, deploymentZone, h, liveUnits, refreshOccupancy } from './battleMap.ts';
import { MAX_FORT, bestFacing, resolveAttack } from './combat.ts';
import type { AttackOutcome } from './combat.ts';
import { costField, pathTo, reachable } from './movement.ts';
import type { Rng } from './rng.ts';
import { createRng } from './rng.ts';
import type { Army, Battle, BattleLogEntry, BattleUnit, GameState, Team } from './types.ts';
import { TEAM_NAME, otherTeam } from './types.ts';
import { unitType } from './units.ts';

export const WARNED_CAP = { placements: 4, range: 6 } as const;

export type ActionResult = { ok: true; outcome?: AttackOutcome } | { ok: false; error: string };

function sys(battle: Battle, text: string, kind: BattleLogEntry['kind'] = 'system'): void {
  battle.log.push({ round: battle.round, team: battle.active, text, kind });
}

function toBattleUnit(army: Army, idx: number): BattleUnit {
  const au = army.units[idx]!;
  const t = unitType(au.typeId);
  return {
    id: au.id,
    typeId: au.typeId,
    label: au.label,
    team: army.team,
    hp: au.hp,
    maxHp: t.hp,
    pos: null,
    facing: army.team === 'A' ? 0 : 3,
    mp: t.move,
    moved: false,
    movedDist: 0,
    acted: false,
    deployed: false,
    suppressed: false,
    revealed: false,
    firstStrikeUsed: false,
  };
}

export function createBattle(
  state: GameState,
  attackerArmy: Army,
  defenderArmy: Army,
  origin: HexKey,
  target: HexKey,
  world: World,
): Battle {
  const mains = [target, ...mainNeighbors(world, target).map((m) => m.key)];
  const forts: Record<HexKey, number> = {};
  for (const mk of mains) {
    for (const sk of world.mainByKey.get(mk)!.subKeys) {
      if (state.forts[sk]) forts[sk] = state.forts[sk]!;
    }
  }
  const warning = state.hexes[target]?.warning ?? 0;
  const battle: Battle = {
    id: `battle-${state.nextId++}`,
    era: state.settings.era,
    attacker: attackerArmy.team,
    defender: defenderArmy.team,
    attackerArmyId: attackerArmy.id,
    defenderArmyId: defenderArmy.id,
    contested: target,
    origin,
    mains,
    phase: 'deploy',
    deployTeam: defenderArmy.team,
    round: 0,
    maxRounds: state.settings.battleRounds,
    active: defenderArmy.team,
    units: [
      ...attackerArmy.units.map((_, i) => toBattleUnit(attackerArmy, i)),
      ...defenderArmy.units.map((_, i) => toBattleUnit(defenderArmy, i)),
    ],
    forts,
    warningTurns: warning,
    warnedPlacements: Math.min(WARNED_CAP.placements, warning * 2),
    warnedRange: Math.min(WARNED_CAP.range, warning * 3),
    log: [],
    winner: null,
    endReason: null,
  };
  sys(
    battle,
    `BATTLE for ${target}: ${TEAM_NAME[battle.attacker]} attacks from ${origin}. ` +
      (warning > 0
        ? `${TEAM_NAME[battle.defender]} had ${warning} turn(s) of warning — ${battle.warnedPlacements} warned fortification(s) within ${battle.warnedRange} MP.`
        : `SURPRISE ATTACK — no warned-category preparation.`),
  );
  return battle;
}

export function contextFor(state: GameState): BattleContext {
  if (!state.battle) throw new Error('No active battle');
  return buildContext(state.settings, state.battle);
}

function unitById(battle: Battle, id: string): BattleUnit | undefined {
  return battle.units.find((u) => u.id === id);
}

// ── Deployment ──

export function deployUnit(
  ctx: BattleContext,
  battle: Battle,
  unitId: string,
  key: HexKey | null,
): ActionResult {
  if (battle.phase !== 'deploy') return { ok: false, error: 'Not in deployment' };
  const u = unitById(battle, unitId);
  if (!u || u.team !== battle.deployTeam) return { ok: false, error: 'Not your unit' };
  if (key === null) {
    u.pos = null;
    refreshOccupancy(ctx, battle);
    return { ok: true };
  }
  if (!deploymentZone(ctx, battle, u.team).includes(key))
    return { ok: false, error: 'Outside deployment zone' };
  const occ = ctx.unitAt.get(key);
  if (occ && occ.id !== u.id) return { ok: false, error: 'Cell occupied' };
  placeUnit(ctx, battle, u, key);
  return { ok: true };
}

function placeUnit(ctx: BattleContext, battle: Battle, u: BattleUnit, key: HexKey): void {
  u.pos = key;
  const enemyMain = u.team === battle.defender ? battle.origin : battle.contested;
  const enemyCentre = ctx.world.mainByKey.get(enemyMain)!.center;
  u.facing = bestFacing(key, `${enemyCentre.q},${enemyCentre.r}`);
  refreshOccupancy(ctx, battle);
}

export function warnedRangeCells(ctx: BattleContext, battle: Battle): Set<HexKey> {
  if (battle.warnedRange <= 0) return new Set();
  const zone = deploymentZone(ctx, battle, battle.defender);
  const field = costField(ctx, zone, 2, battle.warnedRange);
  return new Set(field.keys());
}

export function placeWarnedFort(ctx: BattleContext, battle: Battle, key: HexKey): ActionResult {
  if (battle.phase !== 'deploy' || battle.deployTeam !== battle.defender)
    return { ok: false, error: 'Only the defender places warned fortifications during deployment' };
  if (battle.warnedPlacements <= 0) return { ok: false, error: 'No warned placements left' };
  if (!warnedRangeCells(ctx, battle).has(key))
    return { ok: false, error: 'Outside warned placement range' };
  if ((battle.forts[key] ?? 0) >= MAX_FORT)
    return { ok: false, error: 'Already at max fortification' };
  battle.forts[key] = (battle.forts[key] ?? 0) + 1;
  battle.warnedPlacements -= 1;
  sys(battle, `Sandbags placed at ${key} (L${battle.forts[key]})`, 'info');
  return { ok: true };
}

function deployScore(ctx: BattleContext, battle: Battle, team: Team, key: HexKey): number {
  const enemyMain = team === battle.defender ? battle.origin : battle.contested;
  const enemyCentre = ctx.world.mainByKey.get(enemyMain)!.center;
  const home = ctx.world.mainByKey.get(battle.contested)!.center;
  const p = parseKey(key);
  const height = h(ctx, key);
  const fort = battle.forts[key] ?? 0;
  // Defenders hold the high, fortified heart of the hex; attackers mass on their front edge.
  return team === battle.defender
    ? height * 2 + fort * 4 - hexDistance(p, home) * 0.5
    : -hexDistance(p, enemyCentre) * 1.2 + height * 0.8;
}

export function autoDeploy(ctx: BattleContext, battle: Battle, team: Team, rng: Rng): void {
  const zone = deploymentZone(ctx, battle, team);
  const free = zone.filter((k) => !ctx.unitAt.has(k));
  free.sort((a, b) => deployScore(ctx, battle, team, b) - deployScore(ctx, battle, team, a));
  const pending = battle.units.filter((u) => u.team === team && u.hp > 0 && !u.pos);
  // Fragile/indirect units go further back; front-liners take the best forward cells.
  pending.sort((a, b) => frontRank(a) - frontRank(b));
  for (const u of pending) {
    let pick = free.shift();
    if (!pick) break;
    const t = unitType(u.typeId);
    if (t.attackType === 'indirect' && free.length > 4) {
      free.unshift(pick);
      pick = free.splice(Math.min(free.length - 1, 3 + rng.int(0, 3)), 1)[0]!;
    }
    placeUnit(ctx, battle, u, pick);
  }
}

function frontRank(u: BattleUnit): number {
  const t = unitType(u.typeId);
  if (t.attackType === 'indirect') return 3;
  if (t.engineer) return 2;
  if (t.placementCategory === 'combat_fixed') return 1;
  return 0;
}

export function finishDeployment(ctx: BattleContext, battle: Battle, rng: Rng): ActionResult {
  if (battle.phase !== 'deploy') return { ok: false, error: 'Not in deployment' };
  const team = battle.deployTeam;
  autoDeploy(ctx, battle, team, rng); // place any stragglers
  sys(battle, `${TEAM_NAME[team]} deployment complete`);
  if (team === battle.defender) {
    battle.deployTeam = battle.attacker;
    battle.active = battle.attacker;
    battle.warnedPlacements = 0;
    return { ok: true };
  }
  battle.phase = 'combat';
  battle.round = 1;
  battle.active = battle.attacker;
  startTurn(battle, battle.attacker);
  sys(battle, `ROUND 1 — ${TEAM_NAME[battle.attacker]} to move`);
  return { ok: true };
}

// ── Turn flow ──

export function startTurn(battle: Battle, team: Team): void {
  for (const u of battle.units) {
    if (u.team !== team || u.hp <= 0) continue;
    const t = unitType(u.typeId);
    u.mp = u.suppressed ? Math.floor(t.move / 2) : t.move;
    u.moved = false;
    u.movedDist = 0;
    u.acted = false;
    u.revealed = false;
    u.firstStrikeUsed = false;
  }
}

export function endTurn(ctx: BattleContext, battle: Battle): ActionResult {
  if (battle.phase !== 'combat') return { ok: false, error: 'Battle not in combat' };
  for (const u of battle.units) if (u.team === battle.active) u.suppressed = false;
  const next = otherTeam(battle.active);
  if (next === battle.attacker) {
    if (battle.round >= battle.maxRounds) {
      endByTime(ctx, battle);
      return { ok: true };
    }
    battle.round += 1;
  }
  battle.active = next;
  startTurn(battle, next);
  sys(battle, `ROUND ${battle.round} — ${TEAM_NAME[next]} to move`);
  return { ok: true };
}

function endByTime(ctx: BattleContext, battle: Battle): void {
  const inContested = (team: Team): number =>
    liveUnits(battle, team).filter((u) => ctx.world.subByKey.get(u.pos!)?.main === battle.contested)
      .length;
  const att = inContested(battle.attacker);
  const def = inContested(battle.defender);
  const winner = att > 0 && def === 0 ? battle.attacker : battle.defender;
  finish(
    battle,
    winner,
    `Round limit reached — ${TEAM_NAME[winner]} holds ${battle.contested} (in hex: A${att}/D${def})`,
  );
}

function finish(battle: Battle, winner: Team, reason: string): void {
  battle.phase = 'over';
  battle.winner = winner;
  battle.endReason = reason;
  sys(battle, `BATTLE OVER — ${TEAM_NAME[winner]} wins. ${reason}`);
}

export function checkVictory(battle: Battle): void {
  if (battle.phase !== 'combat') return;
  const a = liveUnits(battle, battle.attacker).length;
  const d = liveUnits(battle, battle.defender).length;
  if (a === 0 && d === 0)
    finish(battle, battle.defender, 'Mutual annihilation — ground stays with the defender');
  else if (a === 0) finish(battle, battle.defender, 'Attacking force destroyed');
  else if (d === 0) finish(battle, battle.attacker, 'Defending force destroyed');
}

export function retreat(battle: Battle, team: Team): ActionResult {
  if (battle.phase === 'over') return { ok: false, error: 'Battle already over' };
  finish(battle, otherTeam(team), `${TEAM_NAME[team]} withdrew from the field`);
  return { ok: true };
}

// ── Unit actions ──

function activeUnit(battle: Battle, unitId: string): BattleUnit | string {
  if (battle.phase !== 'combat') return 'Battle not in combat';
  const u = unitById(battle, unitId);
  if (!u || u.hp <= 0 || !u.pos) return 'Unit not on field';
  if (u.team !== battle.active) return 'Not your unit';
  return u;
}

export function moveUnit(
  ctx: BattleContext,
  battle: Battle,
  unitId: string,
  dest: HexKey,
): ActionResult {
  const u = activeUnit(battle, unitId);
  if (typeof u === 'string') return { ok: false, error: u };
  if (u.acted) return { ok: false, error: 'Unit already acted' };
  if (u.deployed) return { ok: false, error: 'Set up — PACK UP before moving' };
  const reach = reachable(ctx, u);
  const node = reach.get(dest);
  if (!node || dest === u.pos) return { ok: false, error: 'Unreachable' };
  const path = pathTo(reach, dest);
  const last = path[path.length - 2]!;
  const dir = directionTo(parseKey(last), parseKey(dest));
  if (dir >= 0) u.facing = dir;
  u.mp -= node.cost;
  u.moved = true;
  u.movedDist += path.length - 1;
  u.pos = dest;
  refreshOccupancy(ctx, battle);
  return { ok: true };
}

export function attack(
  ctx: BattleContext,
  battle: Battle,
  rng: Rng,
  unitId: string,
  target: HexKey,
): ActionResult {
  const u = activeUnit(battle, unitId);
  if (typeof u === 'string') return { ok: false, error: u };
  const out = resolveAttack(ctx, rng, battle, u, target);
  if ('error' in out) return { ok: false, error: out.error };
  checkVictory(battle);
  return { ok: true, outcome: out };
}

export function setUp(battle: Battle, unitId: string): ActionResult {
  const u = activeUnit(battle, unitId);
  if (typeof u === 'string') return { ok: false, error: u };
  if (unitType(u.typeId).placementCategory !== 'combat_fixed')
    return { ok: false, error: 'Only combat_fixed units set up' };
  if (u.deployed) return { ok: false, error: 'Already set up' };
  if (u.acted) return { ok: false, error: 'Unit already acted' };
  u.deployed = true;
  u.mp = 0;
  // Setting up after moving uses the whole activation.
  if (u.moved) u.acted = true;
  sys(
    battle,
    `${u.label} SET UP${u.moved ? ' (moved — cannot fire until next turn)' : ''}`,
    'info',
  );
  return { ok: true };
}

export function packUp(battle: Battle, unitId: string): ActionResult {
  const u = activeUnit(battle, unitId);
  if (typeof u === 'string') return { ok: false, error: u };
  if (!u.deployed) return { ok: false, error: 'Not set up' };
  if (u.acted) return { ok: false, error: 'Unit already acted' };
  u.deployed = false;
  u.acted = true;
  u.mp = 0;
  sys(battle, `${u.label} PACKED UP (turn spent)`, 'info');
  return { ok: true };
}

export function digIn(battle: Battle, unitId: string): ActionResult {
  const u = activeUnit(battle, unitId);
  if (typeof u === 'string') return { ok: false, error: u };
  if (!unitType(u.typeId).engineer) return { ok: false, error: 'Only engineers can dig in' };
  if (u.acted) return { ok: false, error: 'Unit already acted' };
  const lvl = battle.forts[u.pos!] ?? 0;
  if (lvl >= MAX_FORT) return { ok: false, error: 'Fortification already at max' };
  battle.forts[u.pos!] = lvl + 1;
  u.acted = true;
  u.mp = 0;
  sys(battle, `${u.label} digs in at ${u.pos} → fortification L${lvl + 1}`, 'info');
  return { ok: true };
}

export function rotateUnit(battle: Battle, unitId: string, dir: number): ActionResult {
  const u = activeUnit(battle, unitId);
  if (typeof u === 'string') return { ok: false, error: u };
  if (u.acted) return { ok: false, error: 'Unit already acted' };
  if (u.mp < 1) return { ok: false, error: 'Needs 1 MP to rotate' };
  u.facing = ((dir % 6) + 6) % 6;
  u.mp -= 1;
  return { ok: true };
}

export function battleRng(state: GameState): Rng {
  return createRng(state.rng);
}
