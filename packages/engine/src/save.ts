// ── Save files: envelope, structural validation and migration (V1.0) ────────
// A save is a JSON envelope around a `GameState`. `deserializeSave` never throws:
// bad JSON, a foreign file, a save from a newer build or a structurally broken
// state all come back as `{ ok: false, error }` with a readable message.
//
// Schema history:
//   1 — V0.9: a bare `GameState` (no envelope), armies on main hexes.
//   2 — V1.0: envelope; commanders/garrisons on the sub-hex grid.

import type { World } from './grid.ts';
import { GRID_LIMITS, buildWorld } from './grid.ts';
import { validateRulesOverride } from './rulesValidate.ts';
import type { RulesOverride } from './rules.ts';
import { withRules } from './rules.ts';
import {
  COMMAND,
  ENGINE_VERSION,
  armyMoves,
  centerKey,
  freeSubNear,
  garrisonOf,
  isPresent,
  newId,
  setHolderPos,
} from './strategic.ts';
import { resolveBattleObjective } from './tactical.ts';
import type { Army, GameState, Team } from './types.ts';
import { UNIT_TYPES, unitType } from './units.ts';

export const SAVE_FORMAT = 'iron-ridge-save';
/** Current save schema. 1 = V0.9 bare GameState, 2 = V1.0 envelope + holders. */
export const SAVE_SCHEMA = 2;

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  schema: number;
  engineVersion: string;
  /** ISO-8601 timestamp. */
  savedAt: string;
  label: string;
  state: GameState;
}

export type DeserializeResult =
  { ok: true; save: SaveFile; migrated: string[] } | { ok: false; error: string };

export type MigrateResult =
  { ok: true; state: GameState; notes: string[] } | { ok: false; error: string };

const TEAMS: Team[] = ['A', 'B'];
const PHASES = ['strategic', 'battle-pending', 'battle', 'over'];
const BATTLE_PHASES = ['deploy', 'combat', 'over'];
const OBJECTIVES = ['hold_contested', 'capture_point'];
const ERAS = ['medieval', 'ww2'];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
const isTeam = (v: unknown): v is Team => v === 'A' || v === 'B';
const isStr = (v: unknown): v is string => typeof v === 'string';

// ── Serialise ──

export function defaultSaveLabel(state: GameState): string {
  const where = state.phase === 'battle' ? `battle (${state.battle?.phase ?? '?'})` : state.phase;
  return `Turn ${state.turn} · ${where}`;
}

export function serializeSave(state: GameState, label?: string, now?: Date | string): string {
  const savedAt =
    now === undefined
      ? new Date().toISOString()
      : typeof now === 'string'
        ? now
        : now.toISOString();
  const file: SaveFile = {
    format: SAVE_FORMAT,
    schema: SAVE_SCHEMA,
    engineVersion: ENGINE_VERSION,
    savedAt,
    label: label && label.trim() ? label.trim() : defaultSaveLabel(state),
    state,
  };
  return JSON.stringify(file);
}

// ── Deserialise ──

function summarise(errors: string[]): string {
  const head = errors.slice(0, 3).join('; ');
  return errors.length > 3 ? `${head} (+${errors.length - 3} more)` : head;
}

/** Parse, migrate and validate a save file. Never throws. */
export function deserializeSave(text: string): DeserializeResult {
  try {
    if (typeof text !== 'string' || text.trim() === '')
      return { ok: false, error: 'Save is empty' };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, error: 'Save is not valid JSON (truncated or corrupted)' };
    }
    if (!isObj(raw)) return { ok: false, error: 'Save is not an Iron Ridge save file' };

    let schema: number;
    let stateRaw: unknown;
    let label: string;
    let savedAt: string;
    if (raw.format !== undefined) {
      if (raw.format !== SAVE_FORMAT)
        return { ok: false, error: 'Save is not an Iron Ridge save file' };
      if (!isInt(raw.schema) || raw.schema < 1)
        return { ok: false, error: 'Save has no valid schema number' };
      if (raw.schema > SAVE_SCHEMA)
        return {
          ok: false,
          error: `Save was made by a newer version (schema ${raw.schema}, engine ${String(raw.engineVersion ?? '?')}); this build reads schema ≤ ${SAVE_SCHEMA}`,
        };
      schema = raw.schema;
      stateRaw = raw.state;
      label = isStr(raw.label) ? raw.label : '';
      savedAt = isStr(raw.savedAt) ? raw.savedAt : new Date(0).toISOString();
    } else if ('settings' in raw && 'armies' in raw) {
      schema = 1;
      stateRaw = raw;
      label = '';
      savedAt = new Date(0).toISOString();
    } else {
      return { ok: false, error: 'Save is not an Iron Ridge save file' };
    }

    const mig = migrateSave(stateRaw, schema);
    if (!mig.ok) return mig;
    const errors = validateGameState(mig.state);
    if (errors.length) return { ok: false, error: `Save failed validation: ${summarise(errors)}` };
    const save: SaveFile = {
      format: SAVE_FORMAT,
      schema: SAVE_SCHEMA,
      engineVersion:
        schema === SAVE_SCHEMA && isStr(raw.engineVersion) ? raw.engineVersion : ENGINE_VERSION,
      savedAt,
      label: label || defaultSaveLabel(mig.state),
      state: mig.state,
    };
    return { ok: true, save, migrated: mig.notes };
  } catch (e) {
    return {
      ok: false,
      error: `Save could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── Migration ──

/** Minimum shape a state needs before migration steps can touch it. */
function preflight(raw: unknown): string | null {
  if (!isObj(raw)) return 'state is not an object';
  if (!isObj(raw.settings)) return 'state.settings missing';
  const s = raw.settings;
  if (!isObj(s.grid)) return 'settings.grid missing';
  for (const k of ['mainCols', 'mainRows', 'subRadius'] as const) {
    const v = s.grid[k];
    const lim = GRID_LIMITS[k];
    if (!isInt(v) || v < lim.min || v > lim.max) return `settings.grid.${k} invalid`;
  }
  if (!Array.isArray(raw.armies)) return 'state.armies missing';
  if (!isObj(raw.hq) || !isStr(raw.hq.A) || !isStr(raw.hq.B)) return 'state.hq missing';
  if (!isInt(raw.nextId)) return 'state.nextId missing';
  return null;
}

/**
 * Bring a raw state from `fromSchema` up to `SAVE_SCHEMA`. Each applied step adds
 * a human-readable note. Does not validate the result (see `validateGameState`).
 */
export function migrateSave(raw: unknown, fromSchema = 1): MigrateResult {
  try {
    const bad = preflight(raw);
    if (bad) return { ok: false, error: `Save is not a valid game state: ${bad}` };
    const state = structuredClone(raw) as GameState;
    const notes: string[] = [];
    if (fromSchema < 2) {
      notes.push(
        `Upgraded V${isStr(state.version) ? state.version : '0.9'} save (schema 1) to schema ${SAVE_SCHEMA}`,
      );
      migrate1to2(state, notes);
    }
    return { ok: true, state, notes };
  } catch (e) {
    return {
      ok: false,
      error: `Save could not be migrated: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function migrate1to2(state: GameState, notes: string[]): void {
  const world = buildWorld(state.settings.grid);
  const n = world.config.subRadius;

  // Battle: missing objective / extracted, BattleUnit.revealed → exposed.
  if (isObj(state.battle)) {
    const b = state.battle;
    if (!isObj(b.objective) && isStr(b.contested) && world.mainByKey.has(b.contested)) {
      b.objective = resolveBattleObjective(state, b.contested, world);
      notes.push('Battle had no objective — applied the default capture point');
    }
    if (typeof b.extracted !== 'boolean') b.extracted = false;
    let renamed = 0;
    if (Array.isArray(b.units)) {
      for (const u of b.units as unknown as Obj[]) {
        if (!('exposed' in u) && 'revealed' in u) {
          u.exposed = Boolean(u.revealed);
          delete u.revealed;
          renamed++;
        }
        if (typeof u.exposed !== 'boolean') u.exposed = false;
      }
    }
    if (renamed) notes.push(`Renamed "revealed" → "exposed" on ${renamed} battle unit(s)`);
  }

  // Armies: V0.9 main-hex armies → commanders on sub-hexes.
  const legacy = state.armies.filter((a) => !isStr(a.kind) || !isStr(a.pos));
  const dropped = legacy.filter((a) => !Array.isArray(a.units) || a.units.length === 0);
  if (dropped.length) {
    state.armies = state.armies.filter((a) => !dropped.includes(a));
    notes.push(`Removed ${dropped.length} empty V0.9 army record(s)`);
  }
  const toPlace = legacy.filter((a) => !dropped.includes(a));

  // HQ garrisons first, so they get the HQ centre.
  for (const team of TEAMS) {
    if (garrisonOf(state, team)) continue;
    const hq = state.hq[team];
    if (!world.mainByKey.has(hq)) continue; // validation reports it
    const centre = centerKey(world, hq);
    const taken = state.armies.some((a) => isStr(a.pos) && isPresent(a) && a.pos === centre);
    const pos = taken ? freeSubNear(state, world, centre, hq) : centre;
    if (!pos) throw new Error(`no free cell for the ${team} HQ garrison`);
    const garrison: Army = {
      id: newId(state, `${team}garrison`),
      team,
      kind: 'garrison',
      building: 'hq',
      pos,
      at: hq,
      units: [],
      movesLeft: 0,
    };
    state.armies.push(garrison);
    notes.push(`Added an empty HQ garrison for team ${team} at ${hq}`);
  }

  if (toPlace.length) {
    // Anything without a sub-hex yet must not count as occupying one.
    const pending = new Set(toPlace);
    for (const a of toPlace) {
      if (!isStr(a.at) || !world.mainByKey.has(a.at))
        throw new Error(`army ${a.id} is off the map`);
      const others = state.armies;
      state.armies = others.filter((x) => !pending.has(x) || x === a);
      a.kind = 'commander';
      delete (a as Partial<Army>).pos;
      const from = centerKey(world, a.at);
      const cell =
        freeSubNear(state, world, from, a.at, a.id) ??
        freeSubNear(state, world, from, undefined, a.id);
      state.armies = others;
      if (!cell) throw new Error(`no free cell for army ${a.id}`);
      setHolderPos(world, a, cell);
      // V0.9 moves were main-hex steps; one main step ≈ commandMove(n) sub-steps.
      const old = isNum(a.movesLeft) ? a.movesLeft : 0;
      a.movesLeft = Math.min(armyMoves(a, n), Math.max(0, old) * COMMAND.commandMove(n));
      pending.delete(a);
    }
    notes.push(
      `Placed ${toPlace.length} V0.9 army(ies) as commanders on sub-hexes; moves rescaled to sub-hex steps`,
    );
  }

  if (state.version !== ENGINE_VERSION) {
    notes.push(`Engine version ${String(state.version)} → ${ENGINE_VERSION}`);
    state.version = ENGINE_VERSION;
  }
}

// ── Structural validation ──

/**
 * Structural guard: enough checks that `apply()` will not crash on the state.
 * Returns a list of human-readable errors (empty = valid).
 */
export function validateGameState(raw: unknown): string[] {
  const errors: string[] = [];
  const err = (m: string): void => {
    errors.push(m);
  };
  try {
    if (!isObj(raw)) return ['state: must be an object'];
    const g = raw;
    if (!isStr(g.version)) err('version: must be a string');

    // Settings
    const s = g.settings;
    if (!isObj(s)) return [...errors, 'settings: missing'];
    if (!ERAS.includes(s.era as string)) err(`settings.era: unknown era ${String(s.era)}`);
    let world: World | null = null;
    if (!isObj(s.grid)) err('settings.grid: missing');
    else {
      let gridOk = true;
      for (const k of ['mainCols', 'mainRows', 'subRadius'] as const) {
        const v = s.grid[k];
        const lim = GRID_LIMITS[k];
        if (!isInt(v) || v < lim.min || v > lim.max) {
          err(`settings.grid.${k}: must be an integer in [${lim.min}, ${lim.max}]`);
          gridOk = false;
        }
      }
      if (gridOk) world = buildWorld(s.grid as unknown as World['config']);
    }
    if (!isNum(s.seed)) err('settings.seed: must be a number');
    if (
      !isObj(s.controllers) ||
      !TEAMS.every((t) => ['human', 'ai'].includes((s.controllers as Obj)[t] as string))
    )
      err('settings.controllers: A and B must be "human" or "ai"');
    if (typeof s.fog !== 'boolean') err('settings.fog: must be a boolean');
    if (!isInt(s.battleRounds) || s.battleRounds < 1 || s.battleRounds > 100)
      err('settings.battleRounds: must be an integer in [1, 100]');
    if (s.battleObjective !== undefined && !isObj(s.battleObjective))
      err('settings.battleObjective: must be an object');
    if (s.transferRule !== undefined) {
      const tr = s.transferRule;
      if (!isObj(tr)) err('settings.transferRule: must be an object');
      else {
        if (tr.radius !== undefined && tr.radius !== null && !(isInt(tr.radius) && tr.radius >= 0))
          err('settings.transferRule.radius: must be a non-negative integer or null');
        if (tr.sameMainHex !== undefined && typeof tr.sameMainHex !== 'boolean')
          err('settings.transferRule.sameMainHex: must be a boolean');
      }
    }
    let rules: RulesOverride | undefined;
    let rulesOk = true;
    if (s.rules !== undefined) {
      const rv = validateRulesOverride(s.rules);
      if (!rv.ok) {
        rulesOk = false;
        for (const e of rv.errors) err(`settings.rules.${e}`);
      } else rules = s.rules as RulesOverride;
    }
    const era = s.era as string;

    // Top-level scalars
    if (!PHASES.includes(g.phase as string)) err(`phase: unknown phase ${String(g.phase)}`);
    if (!isInt(g.turn) || g.turn < 1) err('turn: must be a positive integer');
    if (!isTeam(g.active)) err('active: must be "A" or "B"');
    if (
      !isObj(g.cp) ||
      !TEAMS.every((t) => isNum((g.cp as Obj)[t]) && ((g.cp as Obj)[t] as number) >= 0)
    )
      err('cp: A and B must be non-negative numbers');
    if (!isNum(g.rng)) err('rng: must be a number');
    if (!isInt(g.nextId) || g.nextId < 1) err('nextId: must be a positive integer');
    if (!Array.isArray(g.log)) err('log: must be an array');
    if (g.winner !== null && !isTeam(g.winner)) err('winner: must be null, "A" or "B"');

    const isMain = (k: unknown): boolean => isStr(k) && !!world?.mainByKey.has(k);
    const isSub = (k: unknown): boolean => isStr(k) && !!world?.subByKey.has(k);

    if (!isObj(g.hq) || !TEAMS.every((t) => isStr((g.hq as Obj)[t])))
      err('hq: A and B must be main-hex keys');
    else if (world)
      for (const t of TEAMS)
        if (!isMain(g.hq[t])) err(`hq.${t}: ${String(g.hq[t])} is not a main hex on this map`);

    if (!isObj(g.hexes)) err('hexes: missing');
    else if (world) {
      for (const m of world.mains) {
        const h = g.hexes[m.key];
        if (!isObj(h)) err(`hexes.${m.key}: missing`);
        else {
          if (h.owner !== null && !isTeam(h.owner)) err(`hexes.${m.key}.owner: invalid`);
          if (!isInt(h.warning) || h.warning < 0) err(`hexes.${m.key}.warning: invalid`);
        }
      }
    }

    if (!isObj(g.forts)) err('forts: missing');
    else
      for (const [k, v] of Object.entries(g.forts)) {
        if (world && !isSub(k)) err(`forts.${k}: not a sub-hex on this map`);
        if (!isInt(v) || v < 0 || v > 10) err(`forts.${k}: level must be an integer 0–10`);
      }

    // Holders
    const armyIds = new Set<string>();
    const unitIds = new Set<string>();
    const cells = new Map<string, string>();
    const checkUnitType = (path: string, typeId: unknown): boolean => {
      if (!isStr(typeId) || !UNIT_TYPES[typeId]) {
        err(`${path}.typeId: unknown unit type ${String(typeId)}`);
        return false;
      }
      if (UNIT_TYPES[typeId]!.era !== era) {
        err(`${path}.typeId: ${typeId} is not a ${era} unit`);
        return false;
      }
      return true;
    };
    // Units created before/outside an override keep baseline hp, so accept either ceiling.
    const maxHp = (typeId: string): number =>
      Math.max(UNIT_TYPES[typeId]!.hp, rulesOk ? withRules(rules, () => unitType(typeId).hp) : 0);

    if (!Array.isArray(g.armies)) err('armies: must be an array');
    else
      g.armies.forEach((a: unknown, i: number) => {
        const p = `armies[${i}]`;
        if (!isObj(a)) return err(`${p}: must be an object`);
        if (!isStr(a.id) || !a.id) err(`${p}.id: missing`);
        else if (armyIds.has(a.id)) err(`${p}.id: duplicate ${a.id}`);
        else armyIds.add(a.id);
        if (!isTeam(a.team)) err(`${p}.team: invalid`);
        if (a.kind !== 'commander' && a.kind !== 'garrison')
          err(`${p}.kind: must be commander or garrison`);
        if (a.kind === 'garrison' && a.building !== 'hq')
          err(`${p}.building: garrison needs building "hq"`);
        if (!isNum(a.movesLeft) || a.movesLeft < 0) err(`${p}.movesLeft: invalid`);
        if (world) {
          if (!isSub(a.pos)) err(`${p}.pos: ${String(a.pos)} is not a sub-hex on this map`);
          else if (a.at !== world.subByKey.get(a.pos as string)!.main)
            err(`${p}.at: ${String(a.at)} does not contain pos ${String(a.pos)}`);
        }
        if (!Array.isArray(a.units)) return err(`${p}.units: must be an array`);
        a.units.forEach((u: unknown, j: number) => {
          const up = `${p}.units[${j}]`;
          if (!isObj(u)) return err(`${up}: must be an object`);
          if (!isStr(u.id) || !u.id) err(`${up}.id: missing`);
          else if (unitIds.has(u.id)) err(`${up}.id: duplicate unit ${u.id}`);
          else unitIds.add(u.id);
          if (!isStr(u.label)) err(`${up}.label: missing`);
          if (checkUnitType(up, u.typeId)) {
            const max = maxHp(u.typeId as string);
            if (!isNum(u.hp) || u.hp <= 0 || u.hp > max) err(`${up}.hp: must be in (0, ${max}]`);
          }
        });
        const present = a.kind === 'garrison' || a.units.length > 0;
        if (present && isStr(a.pos)) {
          const other = cells.get(a.pos);
          if (other) err(`${p}: shares sub-hex ${a.pos} with ${other}`);
          else cells.set(a.pos, String(a.id));
        }
      });

    // Pending battle / battle consistency with phase
    const phase = g.phase as string;
    const pend = g.pending;
    if (pend !== null && pend !== undefined) {
      if (!isObj(pend)) err('pending: must be an object or null');
      else {
        if (!armyIds.has(pend.attackerArmyId as string))
          err('pending.attackerArmyId: unknown holder');
        if (!armyIds.has(pend.defenderArmyId as string))
          err('pending.defenderArmyId: unknown holder');
        if (world && !isMain(pend.origin)) err('pending.origin: not a main hex');
        if (world && !isMain(pend.target)) err('pending.target: not a main hex');
      }
    } else if (pend === undefined) err('pending: missing (use null)');
    if (g.battle === undefined) err('battle: missing (use null)');
    if (phase === 'battle-pending' && !isObj(pend))
      err('phase is battle-pending but pending is null');
    if (phase === 'battle' && !isObj(g.battle)) err('phase is battle but battle is null');
    if (phase === 'strategic' && (isObj(pend) || isObj(g.battle)))
      err('phase is strategic but a battle is pending or active');
    if (phase === 'battle-pending' && isObj(g.battle))
      err('phase is battle-pending but a battle is active');

    if (isObj(g.battle))
      validateBattle(g.battle, err, {
        era,
        armyIds,
        isMain,
        isSub,
        checkUnitType,
        hasWorld: !!world,
      });
  } catch (e) {
    errors.push(`state: validation crashed (${e instanceof Error ? e.message : String(e)})`);
  }
  return errors;
}

function validateBattle(
  b: Obj,
  err: (m: string) => void,
  ctx: {
    era: string;
    armyIds: Set<string>;
    isMain: (k: unknown) => boolean;
    isSub: (k: unknown) => boolean;
    checkUnitType: (path: string, typeId: unknown) => boolean;
    hasWorld: boolean;
  },
): void {
  if (!isStr(b.id)) err('battle.id: missing');
  if (b.era !== ctx.era) err('battle.era: does not match settings.era');
  if (!isTeam(b.attacker) || !isTeam(b.defender) || b.attacker === b.defender)
    err('battle.attacker/defender: must be the two different teams');
  if (!ctx.armyIds.has(b.attackerArmyId as string)) err('battle.attackerArmyId: unknown holder');
  if (!ctx.armyIds.has(b.defenderArmyId as string)) err('battle.defenderArmyId: unknown holder');
  if (ctx.hasWorld) {
    if (!ctx.isMain(b.contested)) err('battle.contested: not a main hex');
    if (!ctx.isMain(b.origin)) err('battle.origin: not a main hex');
    if (!Array.isArray(b.mains) || b.mains.length === 0 || !b.mains.every(ctx.isMain))
      err('battle.mains: must be a list of main hexes');
  }
  if (!BATTLE_PHASES.includes(b.phase as string)) err(`battle.phase: unknown ${String(b.phase)}`);
  if (!isTeam(b.deployTeam)) err('battle.deployTeam: invalid');
  if (!isTeam(b.active)) err('battle.active: invalid');
  if (!isInt(b.round) || b.round < 0) err('battle.round: invalid');
  if (!isInt(b.maxRounds) || b.maxRounds < 1) err('battle.maxRounds: invalid');
  for (const k of ['warningTurns', 'warnedPlacements', 'warnedRange'] as const)
    if (!isInt(b[k]) || (b[k] as number) < 0) err(`battle.${k}: invalid`);
  if (!isObj(b.forts)) err('battle.forts: missing');
  else
    for (const [k, v] of Object.entries(b.forts)) {
      if (ctx.hasWorld && !ctx.isSub(k)) err(`battle.forts.${k}: not a sub-hex`);
      if (!isInt(v) || v < 0 || v > 10) err(`battle.forts.${k}: level must be an integer 0–10`);
    }
  const o = b.objective;
  if (!isObj(o)) err('battle.objective: missing');
  else {
    if (!OBJECTIVES.includes(o.kind as string)) err('battle.objective.kind: invalid');
    if (!isInt(o.captureRadius) || o.captureRadius < 0)
      err('battle.objective.captureRadius: invalid');
    if (typeof o.extractionAtOrigin !== 'boolean')
      err('battle.objective.extractionAtOrigin: invalid');
    if (o.captureKey !== undefined && !isStr(o.captureKey))
      err('battle.objective.captureKey: invalid');
  }
  if (typeof b.extracted !== 'boolean') err('battle.extracted: must be a boolean');
  if (!Array.isArray(b.log)) err('battle.log: must be an array');
  if (b.winner !== null && !isTeam(b.winner)) err('battle.winner: invalid');
  if (b.endReason !== null && !isStr(b.endReason)) err('battle.endReason: invalid');
  if (b.phase === 'over' && !isTeam(b.winner)) err('battle.phase is over but no winner');

  if (!Array.isArray(b.units)) return err('battle.units: must be an array');
  const ids = new Set<string>();
  const cells = new Map<string, string>();
  b.units.forEach((u: unknown, i: number) => {
    const p = `battle.units[${i}]`;
    if (!isObj(u)) return err(`${p}: must be an object`);
    if (!isStr(u.id)) err(`${p}.id: missing`);
    else if (ids.has(u.id)) err(`${p}.id: duplicate ${u.id}`);
    else ids.add(u.id);
    ctx.checkUnitType(p, u.typeId);
    if (!isStr(u.label)) err(`${p}.label: missing`);
    if (!isTeam(u.team)) err(`${p}.team: invalid`);
    if (!isNum(u.maxHp) || u.maxHp <= 0) err(`${p}.maxHp: invalid`);
    else if (!isNum(u.hp) || u.hp < 0 || u.hp > u.maxHp) err(`${p}.hp: must be in [0, maxHp]`);
    if (u.pos !== null && !(ctx.hasWorld ? ctx.isSub(u.pos) : isStr(u.pos)))
      err(`${p}.pos: must be null or a sub-hex`);
    if (!isInt(u.facing) || u.facing < 0 || u.facing > 5) err(`${p}.facing: must be 0–5`);
    if (!isNum(u.mp)) err(`${p}.mp: invalid`);
    if (!isNum(u.movedDist)) err(`${p}.movedDist: invalid`);
    for (const f of ['moved', 'acted', 'deployed', 'suppressed', 'exposed', 'firstStrikeUsed'])
      if (typeof u[f] !== 'boolean') err(`${p}.${f}: must be a boolean`);
    if (isStr(u.pos) && isNum(u.hp) && u.hp > 0) {
      const other = cells.get(u.pos);
      if (other) err(`${p}: shares ${u.pos} with ${other}`);
      else cells.set(u.pos, String(u.id));
    }
  });
}
