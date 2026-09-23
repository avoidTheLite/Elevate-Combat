// ── Tactical AI ──────────────────────────────────────────────────────────────
// Stateless: given a state, return the next single action for the side to act.
// Respects fog of war — it only reasons about enemies its units can see.

import type { HexKey } from '../hex.ts';
import { hexDistance, parseKey } from '../hex.ts';
import type { GameAction } from '../actions.ts';
import type { BattleContext } from '../battleMap.ts';
import { deploymentZone, h, liveUnits, refreshOccupancy } from '../battleMap.ts';
import { MAX_FORT, previewAttack } from '../combat.ts';
import { reachable } from '../movement.ts';
import { contextFor, warnedRangeCells } from '../tactical.ts';
import type { Battle, BattleUnit, GameState } from '../types.ts';
import { unitType } from '../units.ts';
import { visibleEnemies } from '../visibility.ts';

interface Shot {
  cell: HexKey;
  value: number;
}

function bestShot(
  ctx: BattleContext,
  battle: Battle,
  u: BattleUnit,
  enemies: BattleUnit[],
): Shot | null {
  let best: Shot | null = null;
  for (const e of enemies) {
    const pv = previewAttack(ctx, battle, u, e.pos!);
    if (!pv.legal) continue;
    const kill = pv.expectedDamage >= e.hp ? 4 : 0;
    const value =
      pv.expectedDamage + kill + unitType(e.typeId).cost * 0.15 * (pv.pDirect + pv.pSplash);
    if (!best || value > best.value) best = { cell: e.pos!, value };
  }
  return best;
}

function objective(ctx: BattleContext, battle: Battle): HexKey {
  const c = ctx.world.mainByKey.get(battle.contested)!.center;
  return `${c.q},${c.r}`;
}

function threatAt(cell: HexKey, enemies: BattleUnit[]): number {
  const p = parseKey(cell);
  let t = 0;
  for (const e of enemies) {
    const et = unitType(e.typeId);
    const d = hexDistance(p, parseKey(e.pos!));
    if (d <= et.maxRange + (et.attackType === 'melee' ? et.move : 1)) t += et.cost * 0.1;
  }
  return t;
}

function cellScore(
  ctx: BattleContext,
  battle: Battle,
  u: BattleUnit,
  cell: HexKey,
  enemies: BattleUnit[],
  moving: boolean,
): number {
  const t = unitType(u.typeId);
  const orig = { pos: u.pos, moved: u.moved };
  u.pos = cell;
  u.moved = moving || u.moved;
  refreshOccupancy(ctx, battle);
  const shot =
    t.placementCategory === 'combat_fixed' && !u.deployed
      ? null
      : bestShot(ctx, battle, u, enemies);
  u.pos = orig.pos;
  u.moved = orig.moved;
  refreshOccupancy(ctx, battle);

  const obj = parseKey(objective(ctx, battle));
  const distObj = hexDistance(parseKey(cell), obj);
  const attacker = u.team === battle.attacker;
  const inContested = ctx.world.subByKey.get(cell)?.main === battle.contested;
  const height = h(ctx, cell);
  const fort = battle.forts[cell] ?? 0;
  const fragile = t.attackType === 'indirect' || t.engineer;

  let score = (shot?.value ?? 0) * 3;
  score += height * 0.35 + fort * 1.2;
  score -= threatAt(cell, enemies) * (fragile ? 2.5 : 1);
  // Nearest visible enemy pulls melee forward.
  if (t.attackType === 'melee' && enemies.length) {
    const nearest = Math.min(...enemies.map((e) => hexDistance(parseKey(cell), parseKey(e.pos!))));
    score -= nearest * 0.8;
  }
  if (attacker) score -= distObj * (enemies.length ? 0.25 : 0.7) - (inContested ? 2 : 0);
  else score += inContested ? 1.5 : -distObj * 0.3;
  if (fragile && enemies.length) {
    const nearest = Math.min(...enemies.map((e) => hexDistance(parseKey(cell), parseKey(e.pos!))));
    if (nearest < 3) score -= (3 - nearest) * 2;
  }
  return score;
}

export function tacticalAiStep(state: GameState): GameAction {
  const battle = state.battle!;
  const ctx = contextFor(state);

  if (battle.phase === 'over') return { type: 'concludeBattle' };

  if (battle.phase === 'deploy') {
    const team = battle.deployTeam;
    if (team === battle.defender && battle.warnedPlacements > 0) {
      const zone = new Set(deploymentZone(ctx, battle, team));
      const origin = ctx.world.mainByKey.get(battle.origin)!.center;
      const cells = [...warnedRangeCells(ctx, battle)]
        .filter((k) => (battle.forts[k] ?? 0) < MAX_FORT)
        .sort((a, b) => {
          const s = (k: HexKey): number =>
            h(ctx, k) * 1.5 -
            hexDistance(parseKey(k), origin) * 0.5 +
            (zone.has(k) ? 2 : 0) +
            (battle.forts[k] ?? 0);
          return s(b) - s(a);
        });
      if (cells[0]) return { type: 'placeFort', cell: cells[0] };
    }
    return { type: 'finishDeploy' };
  }

  const team = battle.active;
  const mine = liveUnits(battle, team);
  const enemies = visibleEnemies(ctx, battle, team);

  // Withdraw a shattered attacking force rather than feed it in.
  if (team === battle.attacker && battle.round >= 3) {
    const val = (us: BattleUnit[]): number =>
      us.reduce((s, x) => s + unitType(x.typeId).cost * (x.hp / x.maxHp), 0);
    const ours = val(mine);
    const theirs = val(liveUnits(battle, battle.defender));
    if (ours < theirs * 0.25) return { type: 'retreat' };
  }

  const order = [...mine].sort((a, b) => rank(a) - rank(b));
  for (const u of order) {
    if (u.acted) continue;
    const t = unitType(u.typeId);

    // Fire first if a good shot exists from here.
    const shotHere = bestShot(ctx, battle, u, enemies);
    const fixed = t.placementCategory === 'combat_fixed';

    if (fixed) {
      if (u.deployed) {
        if (shotHere) return { type: 'attack', unitId: u.id, cell: shotHere.cell };
        continue;
      }
      // Set up when enemies are (or will soon be) in reach, otherwise advance.
      const soon = enemies.some(
        (e) => hexDistance(parseKey(u.pos!), parseKey(e.pos!)) <= t.maxRange + 2,
      );
      if (soon || u.moved || battle.round >= 3) return { type: 'setUp', unitId: u.id };
      const dest = bestMove(ctx, battle, u, enemies);
      if (dest && dest !== u.pos) return { type: 'move', unitId: u.id, cell: dest };
      return { type: 'setUp', unitId: u.id };
    }

    if (t.engineer && !u.moved) {
      const inContested = ctx.world.subByKey.get(u.pos!)?.main === battle.contested;
      const lvl = battle.forts[u.pos!] ?? 0;
      const exposed = enemies.some((e) => hexDistance(parseKey(u.pos!), parseKey(e.pos!)) <= 2);
      if (
        lvl < MAX_FORT &&
        !exposed &&
        (team === battle.defender ? inContested : inContested || battle.round > 4)
      )
        return { type: 'dig', unitId: u.id };
    }

    if (!u.moved) {
      const dest = bestMove(ctx, battle, u, enemies);
      const stay = cellScore(ctx, battle, u, u.pos!, enemies, false);
      if (dest && dest !== u.pos) {
        const go = cellScore(ctx, battle, u, dest, enemies, true);
        if (go > stay + 0.3) return { type: 'move', unitId: u.id, cell: dest };
      }
    }
    const shot = bestShot(ctx, battle, u, enemies);
    if (shot) return { type: 'attack', unitId: u.id, cell: shot.cell };
    if (t.engineer && u.moved && (battle.forts[u.pos!] ?? 0) < MAX_FORT && team === battle.defender)
      return { type: 'dig', unitId: u.id };
  }
  return { type: 'endBattleTurn' };
}

function rank(u: BattleUnit): number {
  const t = unitType(u.typeId);
  if (t.attackType === 'indirect') return 0;
  if (t.attackType === 'ranged_direct') return 1;
  if (t.engineer) return 3;
  return 2;
}

function bestMove(
  ctx: BattleContext,
  battle: Battle,
  u: BattleUnit,
  enemies: BattleUnit[],
): HexKey | null {
  const reach = reachable(ctx, u);
  let best: HexKey | null = null;
  let bestScore = -Infinity;
  // Sample to keep large reach sets cheap.
  const keys = [...reach.keys()];
  const step = Math.max(1, Math.floor(keys.length / 60));
  for (let i = 0; i < keys.length; i += step) {
    const k = keys[i]!;
    const s = cellScore(ctx, battle, u, k, enemies, k !== u.pos);
    if (s > bestScore) {
      bestScore = s;
      best = k;
    }
  }
  return best;
}
