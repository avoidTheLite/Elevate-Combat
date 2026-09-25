// ── Strategic AI ─────────────────────────────────────────────────────────────
// One action per call; the caller loops until it returns `endTurn`.
// V1.0: recruits muster in the HQ garrison, spare units are formed into
// commanders, and commanders march on the sub-hex grid and engage in range.

import type { GameAction } from '../actions.ts';
import { canTransfer, commanderReach, engageOrigin, engageTargets } from '../command.ts';
import type { World } from '../grid.ts';
import { mainDistance } from '../grid.ts';
import type { Hex } from '../hex.ts';
import { hexDistance } from '../hex.ts';
import {
  COMMAND,
  ECONOMY,
  armiesAt,
  armyStrength,
  attackCost,
  autoResolveOdds,
  freeSubNear,
  garrisonOf,
  hexFortLevel,
  visibleArmies,
  worldOf,
} from '../strategic.ts';
import type { Army, GameState, PendingBattle, Team } from '../types.ts';
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
  const seen = visibleArmies(state, team).filter((a) => a.team === enemy && a.units.length > 0);
  const reserve = 8;
  const hq = state.hq[team];
  const threatened = seen.some((a) => mainDistance(world, a.at, hq) <= 2);
  const garrison = garrisonOf(state, team);
  const gCount = garrison?.units.length ?? 0;

  // 1. Recruit into the HQ garrison.
  if (garrison && gCount < COMMAND.garrisonCap) {
    const mix = RECRUIT_MIX[state.settings.era]!;
    const typeId = mix[(state.turn + gCount) % mix.length]!;
    const cost = unitType(typeId).cost;
    const cheapest = Math.min(...unitsForEra(state.settings.era).map((u) => u.cost));
    if (state.cp[team] - cost >= (threatened ? 0 : reserve)) return { type: 'recruit', typeId };
    if (threatened && state.cp[team] >= cheapest && gCount < 3) {
      const cheap = unitsForEra(state.settings.era).find((u) => u.cost === cheapest)!;
      return { type: 'recruit', typeId: cheap.id };
    }
  }

  // 2. Fortify threatened frontier hexes.
  if (state.cp[team] >= ECONOMY.fortifyCost + reserve + 4) {
    const warned = world.mains
      .filter((m) => state.hexes[m.key]?.owner === team && state.hexes[m.key]!.warning > 0)
      .filter((m) => hexFortLevel(state, world, m.key) < 10)
      .sort((a, b) => hexFortLevel(state, world, a.key) - hexFortLevel(state, world, b.key));
    if (warned[0]) return { type: 'fortify', hex: warned[0].key };
  }
  if (state.cp[team] > 45 && hexFortLevel(state, world, hq) < 12) {
    return { type: 'fortify', hex: hq };
  }

  // 3. Commanders: engage when the odds are good, otherwise march.
  const commanders = state.armies.filter(
    (a) => a.team === team && a.kind === 'commander' && a.movesLeft > 0 && a.units.length > 0,
  );
  for (const army of commanders) {
    const attack = chooseEngagement(state, army);
    if (attack) return { type: 'engage', armyId: army.id, targetId: attack };
    // Hold an HQ commander while enemies are close and the garrison is thin.
    if (army.at === hq && threatened && gCount < 2) continue;
    const dest = chooseStep(state, army, seen);
    if (dest) return { type: 'moveCommander', armyId: army.id, dest };
  }

  // 4. Muster: send spare garrison units into the field (keep 2 home; all when threatened).
  if (garrison && !threatened) {
    const spare = gCount - 2;
    // Top up a commander at HQ that has already spent its moves (no tempo lost).
    const spent = state.armies.find(
      (a) =>
        a.kind === 'commander' &&
        a.team === team &&
        a.movesLeft === 0 &&
        a.units.length < ECONOMY.armyCap &&
        canTransfer(state, garrison, a).ok,
    );
    if (spent && spare >= 1) {
      const n = Math.min(spare, ECONOMY.armyCap - spent.units.length);
      const unitIds = garrison.units.slice(0, n).map((u) => u.id);
      return { type: 'transferUnits', fromId: garrison.id, toId: spent.id, unitIds };
    }
    if (spare >= 4) {
      const unitIds = garrison.units.slice(0, Math.min(spare, ECONOMY.armyCap)).map((u) => u.id);
      if (freeSubNear(state, world, garrison.pos, garrison.at))
        return { type: 'formCommander', fromId: garrison.id, unitIds };
    }
  }
  return { type: 'endTurn' };
}

function pendingFor(world: World, army: Army, target: Army): PendingBattle {
  return {
    attackerArmyId: army.id,
    defenderArmyId: target.id,
    origin: engageOrigin(world, army, target),
    target: target.at,
  };
}

/** Best enemy holder this commander can engage now at acceptable odds. */
function chooseEngagement(state: GameState, army: Army): string | null {
  const { world } = worldOf(state);
  let best: string | null = null;
  let bestOdds = 0;
  for (const t of engageTargets(state, army.id)) {
    const odds = autoResolveOdds(state, pendingFor(world, army, t));
    if (odds >= attackThreshold(state, army, t.at) && odds > bestOdds) {
      bestOdds = odds;
      best = t.id;
    }
  }
  return best;
}

/**
 * Pick a reachable sub-hex. Scores mirror the V0.9 main-hex AI, with progress
 * measured in main-hex units (2n+1 sub steps): advance on the goal, take
 * unheld ground, close to engage range of a beatable enemy, avoid stronger stacks.
 */
function chooseStep(state: GameState, army: Army, seen: Army[]): string | null {
  const { world } = worldOf(state);
  const team: Team = army.team;
  const n = world.config.subRadius;
  const M = COMMAND.commandMove(n);
  const range = COMMAND.engageRange(n);
  const enemyHq = state.hq[otherTeam(team)];
  const hexOf = (k: string): Hex => world.subByKey.get(k)!.hex;

  // Beatable enemies we can afford to attack become the goal; otherwise the enemy HQ.
  const prey = seen
    .map((t) => ({ t, odds: autoResolveOdds(state, pendingFor(world, army, t)) }))
    .filter(
      ({ t, odds }) =>
        odds >= attackThreshold(state, army, t.at) && state.cp[team] >= attackCost(army),
    )
    .sort(
      (a, b) =>
        hexDistance(hexOf(army.pos), hexOf(a.t.pos)) - hexDistance(hexOf(army.pos), hexOf(b.t.pos)),
    );
  const goal = prey[0] ? hexOf(prey[0].t.pos) : world.mainByKey.get(enemyHq)!.center;
  const mine = armyStrength(army);
  const reachOfEnemy = M + range;
  const danger = (h: Hex): boolean =>
    seen
      .filter((a) => a.kind === 'commander' && hexDistance(hexOf(a.pos), h) <= reachOfEnemy)
      .reduce((s, a) => s + armyStrength(a), 0) >
    mine * 1.4;
  const dangerHere = danger(hexOf(army.pos));

  let best: string | null = null;
  let bestScore = 0;
  for (const [k, steps] of commanderReach(state, army)) {
    if (steps === 0) continue;
    const h = hexOf(k);
    const main = world.subByKey.get(k)!.main;
    let score = ((hexDistance(hexOf(army.pos), goal) - hexDistance(h, goal)) / M) * 2;
    const takeable =
      state.hexes[main]?.owner !== team && !armiesAt(state, main).some((a) => a.team !== team);
    if (takeable) score += 3;
    if (takeable && main === enemyHq) score += 40;
    const inRange = prey.find(({ t }) => hexDistance(h, hexOf(t.pos)) <= range);
    // Close to engage range, ideally with a step to spare so the attack lands this turn.
    if (inRange) score += 6 + inRange.odds * 10 + (steps < army.movesLeft ? 2 : 0);
    if (!dangerHere && danger(h)) score -= 8;
    if (score > bestScore) {
      bestScore = score;
      best = k;
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
