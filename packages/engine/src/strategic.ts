// ── Strategic (campaign) layer ───────────────────────────────────────────────
// Main hexes are territory. Units live in holders: commanders move on the
// sub-hex grid (see command.ts), garrisons sit in their building. Engaging an
// enemy holder triggers a battle (fought on the sub-hex grid, or auto-resolved).
// Command Points (CP) are the single currency for recruiting, fortifying and
// opening a deployment (attacking).

import type { HexKey } from './hex.ts';
import { hexDistance, hexKey, neighbors, parseKey } from './hex.ts';
import type { World } from './grid.ts';
import { buildWorld, mainDistance, mainNeighbors, validateConfig } from './grid.ts';
import type { Terrain } from './terrain.ts';
import { generateTerrain, heightAt } from './terrain.ts';
import { lineOfSight } from './los.ts';
import { createRng } from './rng.ts';
import type { Rng } from './rng.ts';
import { MAX_FORT } from './combat.ts';
import { createBattle } from './tactical.ts';
import type {
  Army,
  ArmyUnit,
  Battle,
  GameSettings,
  GameState,
  PendingBattle,
  Team,
  TransferRule,
} from './types.ts';
import { TEAM_NAME, otherTeam } from './types.ts';
import { STARTING_ARMY, unitType } from './units.ts';

export const ENGINE_VERSION = '0.9.0';

export const ECONOMY = {
  startingCp: 20,
  baseIncome: 3,
  perHexIncome: 1,
  attackBaseCost: 4,
  attackPerUnitCost: 1,
  fortifyCost: 6,
  maxFortCellsPerHex: 6,
  armyCap: 8,
  maxTurns: 40,
} as const;

/**
 * Command-layer tunables (V1.0). Distances are in sub-hex steps and are
 * functions of the grid's sub-radius n, so every grid size keeps the same pace.
 */
export const COMMAND = {
  /** Sub-hex steps per turn: 2n+1 ≈ one main hex, matching the V0.9 pace. */
  commandMove: (subRadius: number): number => 2 * subRadius + 1,
  /** Forced march: every unit has move ≥ this → steps are multiplied. */
  forcedMarchMinMove: 5,
  forcedMarchMult: 2,
  /** A commander may engage an enemy holder within this many sub-hexes. */
  engageRange: (subRadius: number): number => subRadius,
  /** Holders see enemy holders within this many sub-hexes (with clear LOS). */
  sightRange: (subRadius: number): number => 3 * subRadius,
  /** Strategic observer eye height above the ground (tactical LOS model). */
  sightEye: 1.5,
  /** Default reassignment rule; `settings.transferRule` may switch either check off. */
  transferRule: (subRadius: number): TransferRule => ({ radius: subRadius, sameMainHex: true }),
  garrisonCap: 12,
} as const;

export type StratResult = { ok: true } | { ok: false; error: string };

export function defaultSettings(): GameSettings {
  return {
    era: 'ww2',
    grid: { mainCols: 7, mainRows: 5, subRadius: 4 },
    seed: 1337,
    controllers: { A: 'human', B: 'ai' },
    fog: true,
    battleRounds: 10,
    battleObjective: {
      kind: 'capture_point',
      captureRadius: 1,
      extractionAtOrigin: true,
    },
  };
}

export function worldOf(state: GameState): { world: World; terrain: Terrain } {
  const world = buildWorld(state.settings.grid);
  return { world, terrain: generateTerrain(world, state.settings.seed) };
}

function log(state: GameState, text: string, team: Team = state.active): void {
  state.log.push({ turn: state.turn, team, text });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

/** Append to the campaign log (used by the command layer). */
export const logStrategic = log;

export function newId(state: GameState, prefix: string): string {
  return `${prefix}${state.nextId++}`;
}

export function makeUnit(state: GameState, team: Team, typeId: string): ArmyUnit {
  const t = unitType(typeId);
  const count = state.nextId;
  return { id: newId(state, `${team}u`), typeId, label: `${t.short}-${team}${count}`, hp: t.hp };
}

/** Sub-hex steps a holder gets each turn (garrisons never move). */
export function armyMoves(army: Army, subRadius: number): number {
  if (army.kind !== 'commander') return 0;
  const base = COMMAND.commandMove(subRadius);
  // Forced march: a commander holding only fast units (move ≥ 5) doubles its steps.
  const fast =
    army.units.length > 0 &&
    army.units.every((u) => unitType(u.typeId).move >= COMMAND.forcedMarchMinMove);
  return fast ? base * COMMAND.forcedMarchMult : base;
}

// ── Holders (commanders + garrisons) ──

/** Place a holder on a sub-hex, keeping `at` equal to the containing main hex. */
export function setHolderPos(world: World, army: Army, pos: HexKey): void {
  const s = world.subByKey.get(pos);
  if (!s) throw new Error(`setHolderPos: ${pos} is off the map`);
  army.pos = pos;
  army.at = s.main;
}

/** A holder occupies its sub-hex while it has units — garrisons always do. */
export function isPresent(army: Army): boolean {
  return army.kind === 'garrison' || army.units.length > 0;
}

export function holderAt(state: GameState, subKey: HexKey): Army | undefined {
  return state.armies.find((a) => isPresent(a) && a.pos === subKey);
}

export function occupiedSubs(state: GameState, exceptId?: string): Set<HexKey> {
  return new Set(state.armies.filter((a) => isPresent(a) && a.id !== exceptId).map((a) => a.pos));
}

export function garrisonOf(state: GameState, team: Team): Army | undefined {
  return state.armies.find((a) => a.team === team && a.kind === 'garrison' && a.building === 'hq');
}

/**
 * Nearest unoccupied sub-hex to `from` (ties broken by sub index), optionally
 * restricted to one main hex. `exceptId`'s own cell counts as free.
 */
export function freeSubNear(
  state: GameState,
  world: World,
  from: HexKey,
  main?: HexKey,
  exceptId?: string,
): HexKey | null {
  const origin = world.subByKey.get(from)?.hex ?? parseKey(from);
  const taken = occupiedSubs(state, exceptId);
  const pool = main ? (world.mainByKey.get(main)?.subKeys ?? []) : world.subs.map((s) => s.key);
  let best: HexKey | null = null;
  let bestD = Infinity;
  for (const k of pool) {
    if (taken.has(k)) continue;
    const d = hexDistance(origin, world.subByKey.get(k)!.hex);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

export function centerKey(world: World, main: HexKey): HexKey {
  return hexKey(world.mainByKey.get(main)!.center);
}

export function createGame(input: GameSettings): GameState {
  const settings: GameSettings = { ...input, grid: validateConfig(input.grid) };
  const world = buildWorld(settings.grid);
  const { mainCols, mainRows } = settings.grid;
  const midRow = Math.floor(mainRows / 2);
  const hqA = world.mains.find((m) => m.col === 0 && m.row === midRow)!.key;
  const hqB = world.mains.find((m) => m.col === mainCols - 1 && m.row === midRow)!.key;

  const state: GameState = {
    version: ENGINE_VERSION,
    settings,
    phase: 'strategic',
    turn: 1,
    active: 'A',
    cp: { A: ECONOMY.startingCp, B: ECONOMY.startingCp },
    hq: { A: hqA, B: hqB },
    hexes: {},
    armies: [],
    forts: {},
    pending: null,
    battle: null,
    log: [],
    winner: null,
    rng: (settings.seed * 2654435761) >>> 0,
    nextId: 1,
  };
  for (const m of world.mains) {
    const owner: Team | null = m.col === 0 ? 'A' : m.col === mainCols - 1 ? 'B' : null;
    state.hexes[m.key] = { owner, warning: 0 };
  }
  for (const team of ['A', 'B'] as Team[]) {
    const hqCell = world.mainByKey.get(state.hq[team])!;
    const enemyCentre = world.mainByKey.get(state.hq[otherTeam(team)])!.center;
    // Starting commander: the cell next to the HQ centre that faces the enemy.
    const startPos = neighbors(hqCell.center).sort(
      (x, y) => hexDistance(x, enemyCentre) - hexDistance(y, enemyCentre),
    )[0]!;
    const army: Army = {
      id: newId(state, `${team}army`),
      team,
      kind: 'commander',
      pos: hexKey(startPos),
      at: hqCell.key,
      units: [],
      movesLeft: 0,
    };
    for (const typeId of STARTING_ARMY[settings.era])
      army.units.push(makeUnit(state, team, typeId));
    army.movesLeft = armyMoves(army, settings.grid.subRadius);
    state.armies.push(army);
    // The HQ garrison starts empty on the HQ centre; recruits muster here.
    state.armies.push({
      id: newId(state, `${team}garrison`),
      team,
      kind: 'garrison',
      building: 'hq',
      pos: centerKey(world, hqCell.key),
      at: hqCell.key,
      units: [],
      movesLeft: 0,
    });
    // HQs start with a standing (automatic-category) fortification.
    autoFortify(state, world, generateTerrain(world, settings.seed), state.hq[team], team);
  }
  log(
    state,
    `Campaign start — ${settings.era.toUpperCase()} era, ${mainCols}×${mainRows} main grid, sub-radius ${settings.grid.subRadius}`,
    'A',
  );
  // Income / warning clocks tick at the start of each player's turn — including turn 1.
  beginTurn(state, 'A');
  return state;
}

export function armiesAt(state: GameState, key: HexKey): Army[] {
  return state.armies.filter((a) => a.at === key && a.units.length > 0);
}

export function ownedCount(state: GameState, team: Team): number {
  return Object.values(state.hexes).filter((x) => x.owner === team).length;
}

export function income(state: GameState, team: Team): number {
  return ECONOMY.baseIncome + ECONOMY.perHexIncome * ownedCount(state, team);
}

export function attackCost(army: Army): number {
  return ECONOMY.attackBaseCost + ECONOMY.attackPerUnitCost * army.units.length;
}

export function hexFortLevel(state: GameState, world: World, key: HexKey): number {
  return world.mainByKey.get(key)!.subKeys.reduce((s, k) => s + (state.forts[k] ?? 0), 0);
}

/**
 * Strategic line of sight between two holders: within `sightRange` sub-hexes and
 * the tactical LOS ray (eye `sightEye`) not blocked by the height map.
 */
export function holderSees(world: World, terrain: Terrain, eye: Army, target: Army): boolean {
  const a = world.subByKey.get(eye.pos);
  const b = world.subByKey.get(target.pos);
  if (!a || !b) return false;
  if (hexDistance(a.hex, b.hex) > COMMAND.sightRange(world.config.subRadius)) return false;
  const heightOf = (k: string): number => heightAt(world, terrain, k);
  return lineOfSight(a.hex, b.hex, heightOf, COMMAND.sightEye).status !== 'blocked';
}

/**
 * Strategic fog: own holders, plus enemy holders seen by any own holder (range +
 * LOS) or standing within one main hex of owned territory (V0.9 adjacency vision).
 * Empty garrisons (buildings) are included; empty commanders never exist.
 */
export function visibleArmies(state: GameState, team: Team): Army[] {
  const present = state.armies.filter(isPresent);
  if (!state.settings.fog) return present;
  const { world, terrain } = worldOf(state);
  const owned = Object.entries(state.hexes)
    .filter(([, v]) => v.owner === team)
    .map(([k]) => k);
  const eyes = present.filter((a) => a.team === team);
  return present.filter(
    (a) =>
      a.team === team ||
      owned.some((e) => mainDistance(world, e, a.at) <= 1) ||
      eyes.some((e) => holderSees(world, terrain, e, a)),
  );
}

// ── Automatic-category fortification (strategic spend) ──

function autoFortify(
  state: GameState,
  world: World,
  terrain: Terrain,
  key: HexKey,
  team: Team,
): boolean {
  const cell = world.mainByKey.get(key)!;
  const existing = cell.subKeys.filter((k) => (state.forts[k] ?? 0) > 0);
  // Upgrade path first: harden the weakest existing work.
  const weakest = existing
    .filter((k) => state.forts[k]! < MAX_FORT)
    .sort((a, b) => state.forts[a]! - state.forts[b]!)[0];
  if (weakest && (existing.length >= ECONOMY.maxFortCellsPerHex || state.forts[weakest]! < 2)) {
    state.forts[weakest]! += 1;
    return true;
  }
  if (existing.length >= ECONOMY.maxFortCellsPerHex) return false;
  // New works: high ground, facing the nearest enemy territory.
  const enemy = world.mains.filter((m) => state.hexes[m.key]?.owner === otherTeam(team));
  const threat = enemy.length
    ? enemy.reduce((best, m) =>
        mainDistance(world, key, m.key) < mainDistance(world, key, best.key) ? m : best,
      )
    : null;
  const score = (k: HexKey): number => {
    const s = world.subByKey.get(k)!;
    const hgt = heightAt(world, terrain, k);
    const toward = threat ? -hexDistance(s.hex, threat.center) * 0.35 : 0;
    const centre = -hexDistance(s.hex, cell.center) * 0.2;
    return hgt + toward + centre;
  };
  const pick = cell.subKeys.filter((k) => !state.forts[k]).sort((a, b) => score(b) - score(a))[0];
  if (!pick) return false;
  state.forts[pick] = 2;
  return true;
}

// ── Turn flow ──

function beginTurn(state: GameState, team: Team): void {
  const { world } = worldOf(state);
  state.cp[team] += income(state, team);
  const n = state.settings.grid.subRadius;
  for (const a of state.armies) if (a.team === team) a.movesLeft = armyMoves(a, n);
  // Warning clocks: consecutive turns an enemy holder has sat adjacent to (or inside) our hex.
  const enemyAt = state.armies
    .filter((a) => a.team !== team && a.units.length > 0)
    .map((a) => a.at);
  for (const m of world.mains) {
    const hs = state.hexes[m.key]!;
    if (hs.owner !== team) continue;
    const threatened = enemyAt.some((e) => mainDistance(world, e, m.key) <= 1);
    hs.warning = threatened ? hs.warning + 1 : 0;
  }
}

function teamArmyValue(state: GameState, team: Team): number {
  return state.armies
    .filter((a) => a.team === team && a.units.length > 0)
    .reduce((s, a) => s + armyStrength(a), 0);
}

export function endStrategicTurn(state: GameState): StratResult {
  if (state.phase !== 'strategic') return { ok: false, error: 'Finish the pending battle first' };
  const next = otherTeam(state.active);
  if (next === 'A') state.turn += 1;
  state.active = next;
  if (state.turn > ECONOMY.maxTurns) {
    const a = ownedCount(state, 'A');
    const b = ownedCount(state, 'B');
    let winner: Team | null = null;
    let reason: string;
    if (a !== b) {
      winner = a > b ? 'A' : 'B';
      reason = `Turn limit — ${TEAM_NAME[winner]} holds more territory (${a} vs ${b})`;
    } else {
      const va = teamArmyValue(state, 'A');
      const vb = teamArmyValue(state, 'B');
      if (Math.abs(va - vb) > 0.01) {
        winner = va > vb ? 'A' : 'B';
        reason = `Turn limit — territory tied (${a}); ${TEAM_NAME[winner]} has stronger armies`;
      } else if (state.cp.A !== state.cp.B) {
        winner = state.cp.A > state.cp.B ? 'A' : 'B';
        reason = `Turn limit — territory & armies tied; ${TEAM_NAME[winner]} has more CP`;
      } else {
        reason = `Turn limit — deadlock (${a} hexes each). DRAW.`;
        state.winner = null;
        state.phase = 'over';
        log(state, `★ CAMPAIGN DRAW — ${reason}`, state.active);
        return { ok: true };
      }
    }
    declareWinner(state, winner, reason);
    return { ok: true };
  }
  beginTurn(state, next);
  log(state, `Turn ${state.turn}: ${TEAM_NAME[next]} (+${income(state, next)} CP)`, next);
  return { ok: true };
}

function declareWinner(state: GameState, team: Team, reason: string): void {
  state.winner = team;
  state.phase = 'over';
  log(state, `★ ${TEAM_NAME[team]} WINS THE CAMPAIGN — ${reason}`, team);
}

export function capture(
  state: GameState,
  world: World,
  key: HexKey,
  team: Team,
  viaBattle: boolean,
): void {
  const hs = state.hexes[key]!;
  if (hs.owner === team) return;
  const prev = hs.owner;
  hs.owner = team;
  hs.warning = 0;
  if (!viaBattle && prev) {
    // Uncontested takeover: standing works degrade rather than vanish.
    for (const k of world.mainByKey.get(key)!.subKeys) {
      if (state.forts[k]) {
        state.forts[k]! -= 1;
        if (state.forts[k] === 0) delete state.forts[k];
      }
    }
  }
  log(state, `${TEAM_NAME[team]} takes ${key}${prev ? ` from ${TEAM_NAME[prev]}` : ''}`, team);
  if (prev && state.hq[prev] === key) declareWinner(state, team, `captured ${TEAM_NAME[prev]} HQ`);
}

// ── Orders ──

export function recruit(state: GameState, typeId: string): StratResult {
  if (state.phase !== 'strategic') return { ok: false, error: 'Not in strategic phase' };
  const team = state.active;
  const t = unitType(typeId);
  if (t.era !== state.settings.era) return { ok: false, error: 'Wrong era' };
  if (state.cp[team] < t.cost) return { ok: false, error: `Need ${t.cost} CP` };
  const garrison = garrisonOf(state, team);
  if (!garrison) return { ok: false, error: 'No HQ garrison' };
  if (garrison.units.length >= COMMAND.garrisonCap)
    return { ok: false, error: `HQ garrison is full (${COMMAND.garrisonCap})` };
  garrison.units.push(makeUnit(state, team, typeId));
  state.cp[team] -= t.cost;
  log(state, `Recruited ${t.name} into the HQ garrison (−${t.cost} CP)`);
  return { ok: true };
}

export function fortify(state: GameState, key: HexKey): StratResult {
  if (state.phase !== 'strategic') return { ok: false, error: 'Not in strategic phase' };
  const team = state.active;
  if (state.hexes[key]?.owner !== team)
    return { ok: false, error: 'You can only fortify your own territory' };
  if (state.cp[team] < ECONOMY.fortifyCost)
    return { ok: false, error: `Need ${ECONOMY.fortifyCost} CP` };
  const { world, terrain } = worldOf(state);
  if (!autoFortify(state, world, terrain, key, team))
    return { ok: false, error: 'Hex is fully fortified' };
  state.cp[team] -= ECONOMY.fortifyCost;
  log(state, `Fortified ${key} (−${ECONOMY.fortifyCost} CP)`);
  return { ok: true };
}

// ── Battle hand-off ──

export function startPendingBattle(state: GameState): StratResult {
  const p = state.pending;
  if (state.phase !== 'battle-pending' || !p) return { ok: false, error: 'No pending battle' };
  const att = state.armies.find((a) => a.id === p.attackerArmyId)!;
  const def = state.armies.find((a) => a.id === p.defenderArmyId)!;
  const { world } = worldOf(state);
  state.cp[att.team] -= attackCost(att);
  state.battle = createBattle(state, att, def, p.origin, p.target, world);
  state.phase = 'battle';
  log(
    state,
    `Deployment opened (−${attackCost(att)} CP). Tactical battle begins at ${p.target}.`,
    att.team,
  );
  return { ok: true };
}

export function cancelPendingBattle(state: GameState): StratResult {
  if (state.phase !== 'battle-pending') return { ok: false, error: 'No pending battle' };
  state.pending = null;
  state.phase = 'strategic';
  return { ok: true };
}

function unitValue(u: ArmyUnit): number {
  const t = unitType(u.typeId);
  return t.cost * (u.hp / t.hp);
}

export function armyStrength(army: Army): number {
  return army.units.reduce((s, u) => s + unitValue(u), 0);
}

export function autoResolveOdds(state: GameState, p: PendingBattle): number {
  const { world, terrain } = worldOf(state);
  const att = state.armies.find((a) => a.id === p.attackerArmyId)!;
  const def = state.armies.find((a) => a.id === p.defenderArmyId)!;
  const forts = hexFortLevel(state, world, p.target);
  const hDef = terrain.mainHeight.get(p.target) ?? 0;
  const hAtt = terrain.mainHeight.get(p.origin) ?? 0;
  const defMult = 1 + Math.min(0.6, forts * 0.08) + 0.04 * Math.max(0, hDef - hAtt);
  const sa = armyStrength(att);
  const sd = armyStrength(def) * defMult;
  return sa / Math.max(0.001, sa + sd);
}

function bleed(rng: Rng, army: Army, fraction: number): void {
  for (const u of army.units) {
    const max = unitType(u.typeId).hp;
    const dmg = Math.round(max * fraction * (0.4 + rng.next() * 1.2));
    u.hp = Math.max(0, u.hp - dmg);
  }
  army.units = army.units.filter((u) => u.hp > 0);
}

/** Formula-based auto-resolve: terrain + fortification + force ratio (core-mechanics doc). */
export function autoResolve(state: GameState): StratResult {
  const p = state.pending;
  if (state.phase !== 'battle-pending' || !p) return { ok: false, error: 'No pending battle' };
  const rng = createRng(state.rng);
  const att = state.armies.find((a) => a.id === p.attackerArmyId)!;
  const def = state.armies.find((a) => a.id === p.defenderArmyId)!;
  state.cp[att.team] -= attackCost(att);
  const pA = autoResolveOdds(state, p);
  const attackerWins = rng.next() < pA;
  const pWin = attackerWins ? pA : 1 - pA;
  const winner = attackerWins ? att : def;
  const loser = attackerWins ? def : att;
  bleed(rng, winner, 0.1 + 0.3 * (1 - pWin));
  bleed(rng, loser, 0.35 + 0.35 * pWin);
  state.rng = rng.state();
  log(
    state,
    `AUTO-RESOLVE at ${p.target}: attack odds ${(pA * 100).toFixed(0)}% → ${TEAM_NAME[winner.team]} wins`,
    att.team,
  );
  applyBattleOutcome(state, p, attackerWins ? att.team : def.team);
  return { ok: true };
}

/** Write a finished tactical battle back into the campaign. */
export function concludeBattle(state: GameState): StratResult {
  const b = state.battle;
  if (state.phase !== 'battle' || !b || b.phase !== 'over' || !b.winner)
    return { ok: false, error: 'Battle not finished' };
  const { world } = worldOf(state);
  for (const army of state.armies.filter(
    (a) => a.id === b.attackerArmyId || a.id === b.defenderArmyId,
  )) {
    army.units = army.units
      .map((u) => ({ ...u, hp: b.units.find((bu) => bu.id === u.id)?.hp ?? u.hp }))
      .filter((u) => u.hp > 0);
  }
  // Battlefield fortifications persist as strategic assets.
  for (const mk of b.mains) {
    for (const sk of world.mainByKey.get(mk)!.subKeys) {
      if (b.forts[sk]) state.forts[sk] = b.forts[sk]!;
      else delete state.forts[sk];
    }
  }
  const p: PendingBattle = {
    attackerArmyId: b.attackerArmyId,
    defenderArmyId: b.defenderArmyId,
    origin: b.origin,
    target: b.contested,
  };
  log(
    state,
    `Battle at ${b.contested}: ${TEAM_NAME[b.winner]} victorious (${b.endReason})`,
    b.winner,
  );
  const extracted = b.extracted;
  applyBattleOutcome(state, p, b.winner, extracted);
  return { ok: true };
}

function applyBattleOutcome(
  state: GameState,
  p: PendingBattle,
  winner: Team,
  extracted = false,
): void {
  const { world } = worldOf(state);
  const att = state.armies.find((a) => a.id === p.attackerArmyId);
  const def = state.armies.find((a) => a.id === p.defenderArmyId);
  state.pending = null;
  state.battle = null;
  state.phase = 'strategic';
  if (att) att.movesLeft = 0;

  if (att && winner === att.team) {
    if (def && def.units.length && def.kind === 'garrison') {
      // A beaten garrison is emptied in place; the building (holder) remains.
      log(state, `${TEAM_NAME[def.team]} garrison at ${def.at} is overrun`, def.team);
      def.units = [];
    } else if (def && def.units.length) {
      // Defender survivors fall back to a free cell of adjacent friendly ground, or are lost.
      const fallback = mainNeighbors(world, p.target)
        .filter(
          (m) =>
            state.hexes[m.key]?.owner === def.team &&
            !armiesAt(state, m.key).some((a) => a.team !== def.team),
        )
        .map((m) => freeSubNear(state, world, def.pos, m.key, def.id))
        .find((k): k is HexKey => k !== null);
      if (fallback) {
        setHolderPos(world, def, fallback);
        log(state, `${TEAM_NAME[def.team]} survivors fall back to ${def.at}`, def.team);
      } else {
        log(state, `${TEAM_NAME[def.team]} survivors cut off and lost`, def.team);
        def.units = [];
      }
    }
    if (att.units.length) {
      if (armiesAt(state, p.target).some((a) => a.team !== att.team)) {
        // Another enemy holder still stands in the prize: no capture, stay put.
        log(state, `${TEAM_NAME[att.team]} wins, but ${p.target} is still held`, att.team);
      } else {
        // EXTRACT returns to the origin main hex; SECURE / wipeout occupies the prize.
        const dest = extracted ? p.origin : p.target;
        if (att.at !== dest) {
          const cell = freeSubNear(state, world, att.pos, dest, att.id);
          if (cell) setHolderPos(world, att, cell);
        }
        capture(state, world, p.target, att.team, true);
        if (extracted)
          log(
            state,
            `${TEAM_NAME[att.team]} extracts to ${p.origin} after securing ${p.target}`,
            att.team,
          );
      }
    }
  }
  state.armies = state.armies.filter(isPresent);
  checkElimination(state);
}

function checkElimination(state: GameState): void {
  if (state.winner) return;
  for (const team of ['A', 'B'] as Team[]) {
    const hasArmy = state.armies.some((a) => a.team === team && a.units.length > 0);
    const cheapest = Math.min(
      ...Object.values(STARTING_ARMY[state.settings.era]).map((id) => unitType(id).cost),
    );
    if (!hasArmy && state.cp[team] < cheapest && ownedCount(state, team) <= 1) {
      declareWinner(state, otherTeam(team), `${TEAM_NAME[team]} has no forces left`);
    }
  }
}

export function activeBattle(state: GameState): Battle | null {
  return state.battle;
}
