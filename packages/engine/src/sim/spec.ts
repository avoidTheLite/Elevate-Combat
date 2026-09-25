// ── BattleSpec: one JSON-described micro battle for the combat simulator ─────

import type { RulesOverride } from '../rules.ts';
import { validateRulesOverride } from '../rulesValidate.ts';
import type { Era } from '../units.ts';
import { UNIT_TYPES } from '../units.ts';

export type SimSide = 'attacker' | 'defender';

export interface SpecUnit {
  typeId: string;
  count: number;
  /** Starting HP (absolute, clamped to 1..max). Omitted = full HP. */
  hp?: number;
}

export interface SpecForce {
  units: SpecUnit[];
}

export type SimTerrainKind = 'flat' | 'slope' | 'ridge' | 'seeded';

export interface SpecTerrain {
  /**
   * flat   — every cell height 2.
   * slope  — rises steadily from the attacker's hex (≈2) up through the
   *          defender's hex (≈5).
   * ridge  — the defender's hex is a crest (≈6) falling away on both sides.
   * seeded — the game's procedural terrain for `seed` (default: the run seed).
   */
  kind: SimTerrainKind;
  seed?: number;
}

export interface SpecForts {
  /** Fortification level 1..MAX_FORT. */
  level: number;
  /**
   * 'defender_zone' (default) fortifies every defender deployment cell; a
   * number fortifies that many defender cells, best (most central) first.
   */
  cells?: 'defender_zone' | number;
}

export type ExpectedWinner = SimSide | 'even';

export interface SpecExpect {
  winner: ExpectedWinner;
  /** Win-% margin; default {@link DEFAULT_TOLERANCE}. See `seriesPasses`. */
  tolerance?: number;
}

export interface BattleSpec {
  name: string;
  description?: string;
  era: Era;
  attacker: SpecForce;
  defender: SpecForce;
  terrain?: SpecTerrain;
  forts?: SpecForts;
  /** Battle round limit (default 10, like a new game). */
  maxRounds?: number;
  rules?: RulesOverride;
  expect?: SpecExpect;
}

export const DEFAULT_TOLERANCE = 15;
export const DEFAULT_MAX_ROUNDS = 10;

export type SpecParse =
  { ok: true; spec: BattleSpec; errors: [] } | { ok: false; spec: null; errors: string[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const intIn = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

function parseForce(errors: string[], path: string, v: unknown, era: unknown): void {
  if (!isObj(v) || !Array.isArray(v.units) || v.units.length === 0) {
    errors.push(`${path}.units: must be a non-empty array`);
    return;
  }
  let total = 0;
  v.units.forEach((u: unknown, i: number) => {
    const p = `${path}.units[${i}]`;
    if (!isObj(u)) return void errors.push(`${p}: must be an object`);
    const t = typeof u.typeId === 'string' ? UNIT_TYPES[u.typeId] : undefined;
    if (!t) errors.push(`${p}.typeId: unknown unit type ${String(u.typeId)}`);
    else if (t.era !== era) errors.push(`${p}.typeId: ${t.id} is not a ${String(era)} unit`);
    if (!intIn(u.count, 1, 40)) errors.push(`${p}.count: integer 1..40`);
    else total += u.count as number;
    if (u.hp !== undefined && !intIn(u.hp, 1, 999)) errors.push(`${p}.hp: integer 1..999`);
  });
  if (total > 40) errors.push(`${path}: at most 40 units`);
}

/** Validate untrusted spec JSON (scenario files, CLI, UI). */
export function parseBattleSpec(raw: unknown): SpecParse {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, spec: null, errors: ['spec: must be an object'] };
  if (typeof raw.name !== 'string' || !raw.name) errors.push('name: required string');
  if (raw.era !== 'ww2' && raw.era !== 'medieval') errors.push("era: 'ww2' | 'medieval'");
  parseForce(errors, 'attacker', raw.attacker, raw.era);
  parseForce(errors, 'defender', raw.defender, raw.era);
  if (raw.terrain !== undefined) {
    const t = raw.terrain;
    if (!isObj(t) || !['flat', 'slope', 'ridge', 'seeded'].includes(t.kind as string))
      errors.push("terrain.kind: 'flat' | 'slope' | 'ridge' | 'seeded'");
    else if (t.seed !== undefined && !intIn(t.seed, 0, 2 ** 31))
      errors.push('terrain.seed: integer ≥ 0');
  }
  if (raw.forts !== undefined) {
    const f = raw.forts;
    if (!isObj(f) || !intIn(f.level, 0, 10)) errors.push('forts.level: integer 0..10');
    else if (f.cells !== undefined && f.cells !== 'defender_zone' && !intIn(f.cells, 0, 999))
      errors.push("forts.cells: 'defender_zone' | integer ≥ 0");
  }
  if (raw.maxRounds !== undefined && !intIn(raw.maxRounds, 1, 100))
    errors.push('maxRounds: integer 1..100');
  if (raw.rules !== undefined) {
    const r = validateRulesOverride(raw.rules);
    if (!r.ok) errors.push(...r.errors.map((e) => `rules.${e}`));
  }
  if (raw.expect !== undefined) {
    const e = raw.expect;
    if (!isObj(e) || !['attacker', 'defender', 'even'].includes(e.winner as string))
      errors.push("expect.winner: 'attacker' | 'defender' | 'even'");
    else if (
      e.tolerance !== undefined &&
      (typeof e.tolerance !== 'number' || !(e.tolerance >= 0 && e.tolerance <= 100))
    )
      errors.push('expect.tolerance: number 0..100');
  }
  if (errors.length) return { ok: false, spec: null, errors };
  return { ok: true, spec: structuredClone(raw) as unknown as BattleSpec, errors: [] };
}

/** Parse or throw with every error listed. */
export function assertBattleSpec(raw: unknown): BattleSpec {
  const r = parseBattleSpec(raw);
  if (!r.ok) throw new Error(`Invalid BattleSpec: ${r.errors.join('; ')}`);
  return r.spec;
}

export function specUnitCount(force: SpecForce): number {
  return force.units.reduce((s, u) => s + u.count, 0);
}
