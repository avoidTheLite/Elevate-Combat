// ── Strategic AI ─────────────────────────────────────────────────────────────
// One action per call; the caller loops until it returns `endTurn`.

import type { GameAction } from '../actions.ts';
import { mainDistance, mainNeighbors } from '../grid.ts';
import {
  ECONOMY,
  armiesAt,
  armyStrength,
  attackCost,
  autoResolveOdds,
  canMoveTo,
  hexFortLevel,
  visibleArmies,
  worldOf,
} from '../strategic.ts';
import type { Army, GameState, Team } from '../types.ts';
import { otherTeam } from '../types.ts';
import { unitType, unitsForEra } from '../units.ts';

const RECRUIT_MIX: Record<string, string[]> = {
  ww2: [
    'ww2_rifle_infantry',
    'ww2_tank',
    'ww2_at_infantry',
    'ww2_machine_gun',
    'ww2_mortar',
    'ww2_rifle_infantry',
    'ww2_at_gun',
    'ww2_light_armored_vehicle',
    'ww2_artillery',
    'ww2_engineer',
  ],
  medieval: [
    'med_infantry',
    'med_spearman',
    'med_archers',
    'med_horseman',
    'med_infantry',
    'med_artillery',
    'med_engineer',
    'med_horseman',
  ],
};

export function strategicAiStep(state: GameState): GameAction {
  const team = state.active;
  const enemy = otherTeam(team);
  const { world } = worldOf(state);
  const seen = visibleArmies(state, team).filter((a) => a.team === enemy);
  const reserve = 8;

  // 1. Recruit into the HQ army.
  const hqArmy = armiesAt(state, state.hq[team]).find((a) => a.team === team);
  const hqCount = hqArmy?.units.length ?? 0;
  if (hqCount < ECONOMY.armyCap) {
    const mix = RECRUIT_MIX[state.settings.era]!;
    const typeId = mix[(state.turn + hqCount) % mix.length]!;
    const cost = unitType(typeId).cost;
    const cheapest = Math.min(...unitsForEra(state.settings.era).map((u) => u.cost));
    const threatened = seen.some((a) => mainDistance(world, a.at, state.hq[team]) <= 2);
    if (state.cp[team] - cost >= (threatened ? 0 : reserve)) return { type: 'recruit', typeId };
    if (threatened && state.cp[team] >= cheapest && hqCount < 3) {
      const cheap = unitsForEra(state.settings.era).find((u) => u.cost === cheapest)!;
      return { type: 'recruit', typeId: cheap.id };
    }
  }

  // 2. Fortify threatened frontier hexes.
  if (state.cp[team] >= ECONOMY.fortifyCost + reserve + 4) {
    const threatened = world.mains
      .filter((m) => state.hexes[m.key]?.owner === team && state.hexes[m.key]!.warning > 0)
      .filter((m) => hexFortLevel(state, world, m.key) < 10)
      .sort((a, b) => hexFortLevel(state, world, a.key) - hexFortLevel(state, world, b.key));
    if (threatened[0]) return { type: 'fortify', hex: threatened[0].key };
  }
  if (state.cp[team] > 45 && hexFortLevel(state, world, state.hq[team]) < 12) {
    return { type: 'fortify', hex: state.hq[team] };
  }

  // 3. Move armies.
  const armies = state.armies.filter(
    (a) => a.team === team && a.movesLeft > 0 && a.units.length > 0,
  );
  for (const army of armies) {
    const move = chooseMove(state, army, seen);
    if (move) return { type: 'moveArmy', armyId: army.id, dest: move };
  }
  return { type: 'endTurn' };
}

function chooseMove(state: GameState, army: Army, seen: Army[]): string | null {
  const { world } = worldOf(state);
  const team: Team = army.team;
  const enemyHq = state.hq[otherTeam(team)];
  const ownHq = state.hq[team];

  // Keep a garrison at HQ while enemies are close.
  const nearHq = seen.some((a) => mainDistance(world, a.at, ownHq) <= 2);
  const othersAtHq = state.armies.filter(
    (a) => a.team === team && a.at === ownHq && a.id !== army.id,
  ).length;
  if (army.at === ownHq && nearHq && othersAtHq === 0) return null;
  // Let a small fresh HQ army build up before marching.
  if (army.at === ownHq && army.units.length < 4 && state.turn < 20 && !nearHq) return null;

  let best: string | null = null;
  let bestScore = 0;
  for (const n of mainNeighbors(world, army.at)) {
    const chk = canMoveTo(state, army, n.key);
    if (!chk.ok) continue;
    let score = 0;
    const owner = state.hexes[n.key]?.owner;
    const distEnemyHq = mainDistance(world, n.key, enemyHq);
    score += (mainDistance(world, army.at, enemyHq) - distEnemyHq) * 2;
    if (owner !== team) score += 3;
    if (n.key === enemyHq) score += 40;
    if (chk.battle) {
      const def = armiesAt(state, n.key).find((a) => a.team !== team)!;
      const odds = autoResolveOdds(state, {
        attackerArmyId: army.id,
        defenderArmyId: def.id,
        origin: army.at,
        target: n.key,
      });
      if (odds < attackThreshold(state, army, n.key) || state.cp[team] < attackCost(army)) continue;
      score += 6 + odds * 10;
    } else {
      // Avoid stepping next to a clearly stronger enemy stack.
      const danger = seen.filter((a) => mainDistance(world, a.at, n.key) === 1);
      const dangerStr = danger.reduce((s, a) => s + armyStrength(a), 0);
      if (dangerStr > armyStrength(army) * 1.4) score -= 8;
      // Reinforce a friendly stack on the front line.
      const friend = armiesAt(state, n.key).find((a) => a.team === team);
      if (friend && danger.length) score += 3;
    }
    if (score > bestScore) {
      bestScore = score;
      best = n.key;
    }
  }
  return best;
}

/**
 * Odds needed before the AI opens a deployment. Falls as the war drags on and as
 * CP piles up, so repeated attacks can grind down a fortified position.
 */
function attackThreshold(state: GameState, army: Army, target: string): number {
  let t = 0.55;
  if (target === state.hq[otherTeam(army.team)]) t -= 0.1;
  t -= Math.max(0, state.turn - 12) * 0.01;
  if (state.cp[army.team] > 40) t -= 0.1;
  return Math.max(0.28, t);
}

/** AI-vs-AI pending battles are always auto-resolved. */
export function aiPendingDecision(): GameAction {
  return { type: 'autoResolve' };
}
