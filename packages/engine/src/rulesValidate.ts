// ── Structural guard for RulesOverride JSON (balance lab UI, sim CLI, saves) ──

import { DEFAULT_MECHANICS, mergeUnitStats } from './rules.ts';
import type { RulesOverride, UnitStatsOverride } from './rules.ts';
import type { RangeProfile } from './units.ts';
import { UNIT_TYPES } from './units.ts';

export type RulesValidation =
  { ok: true; rules: RulesOverride; errors: [] } | { ok: false; rules: null; errors: string[] };

/** Inclusive numeric bounds for each editable numeric unit stat. */
export const UNIT_STAT_BOUNDS: Record<string, { min: number; max: number; int: boolean }> = {
  hp: { min: 1, max: 999, int: true },
  move: { min: 0, max: 30, int: true },
  vision: { min: 0, max: 40, int: true },
  minRange: { min: 0, max: 40, int: true },
  maxRange: { min: 0, max: 40, int: true },
  splashRadius: { min: 0, max: 5, int: true },
  cost: { min: 0, max: 999, int: true },
  maxClimb: { min: 0, max: 8, int: true },
  eye: { min: 0, max: 5, int: false },
};

const POOL_BOUNDS: Record<string, { min: number; max: number }> = {
  count: { min: 0, max: 20 },
  sides: { min: 1, max: 100 },
  bonus: { min: -50, max: 50 },
};

const BOOL_FIELDS = new Set(['suppresses', 'firstStrike', 'charge', 'braced', 'engineer']);
const PROFILES: RangeProfile[] = ['rifle_mg', 'at_gun', 'tank_cannon', 'indirect', 'melee'];

/** Every UnitStats field the balance lab may edit. */
export const EDITABLE_UNIT_FIELDS = [
  'short',
  ...Object.keys(UNIT_STAT_BOUNDS),
  'profile',
  'direct',
  'splash',
  ...BOOL_FIELDS,
] as const;

const MECH_BOUNDS: Record<string, { min: number; max: number; int?: boolean }> = {
  MAX_FORT: { min: 0, max: 10, int: true },
  EFFECT_MULT: { min: 0, max: 5 },
  CHARGE_MIN_MOVE: { min: 0, max: 30, int: true },
  FIRST_STRIKE_DENY_MOVE: { min: 0, max: 30, int: true },
};
const DEFAULT_MECH_BOUND = { min: -50, max: 50 };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkNum(
  errors: string[],
  path: string,
  v: unknown,
  b: { min: number; max: number; int?: boolean },
): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${path}: must be a finite number`);
  else if (v < b.min || v > b.max) errors.push(`${path}: ${v} outside [${b.min}, ${b.max}]`);
  else if (b.int && !Number.isInteger(v)) errors.push(`${path}: must be an integer`);
}

function checkPool(errors: string[], path: string, v: unknown): void {
  if (!isObj(v)) {
    errors.push(`${path}: must be a dice pool object`);
    return;
  }
  for (const [k, x] of Object.entries(v)) {
    const b = POOL_BOUNDS[k];
    if (!b) errors.push(`${path}.${k}: unknown dice field`);
    else checkNum(errors, `${path}.${k}`, x, { ...b, int: true });
  }
}

function checkMechanics(
  errors: string[],
  path: string,
  base: unknown,
  v: unknown,
  key: string,
): void {
  if (isObj(base)) {
    if (!isObj(v)) {
      errors.push(`${path}: must be an object`);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (!(k in base)) errors.push(`${path}.${k}: unknown field`);
      else checkMechanics(errors, `${path}.${k}`, base[k], x, key);
    }
    return;
  }
  checkNum(errors, path, v, MECH_BOUNDS[key] ?? DEFAULT_MECH_BOUND);
}

/**
 * Validate untrusted override JSON. Rejects unknown typeIds / fields, non-finite
 * numbers and out-of-range values, and checks each merged unit keeps
 * minRange ≤ maxRange. On success `rules` is a deep copy safe to store.
 */
export function validateRulesOverride(raw: unknown): RulesValidation {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, rules: null, errors: ['rules: must be an object'] };
  for (const k of Object.keys(raw))
    if (k !== 'units' && k !== 'mechanics') errors.push(`rules.${k}: unknown section`);

  if (raw.units !== undefined) {
    if (!isObj(raw.units)) errors.push('units: must be an object keyed by typeId');
    else
      for (const [id, o] of Object.entries(raw.units)) {
        const p = `units.${id}`;
        if (!UNIT_TYPES[id]) {
          errors.push(`${p}: unknown unit type`);
          continue;
        }
        if (!isObj(o)) {
          errors.push(`${p}: must be an object`);
          continue;
        }
        for (const [f, v] of Object.entries(o)) {
          const fp = `${p}.${f}`;
          if (UNIT_STAT_BOUNDS[f]) checkNum(errors, fp, v, UNIT_STAT_BOUNDS[f]!);
          else if (BOOL_FIELDS.has(f)) {
            if (typeof v !== 'boolean') errors.push(`${fp}: must be a boolean`);
          } else if (f === 'short') {
            if (typeof v !== 'string' || v.length < 1 || v.length > 6)
              errors.push(`${fp}: must be a 1–6 character string`);
          } else if (f === 'profile') {
            if (!PROFILES.includes(v as RangeProfile))
              errors.push(`${fp}: must be one of ${PROFILES.join(', ')}`);
          } else if (f === 'direct') checkPool(errors, fp, v);
          else if (f === 'splash') {
            if (v !== null) checkPool(errors, fp, v);
          } else errors.push(`${fp}: unknown or non-editable field`);
        }
        const merged = mergeUnitStats(UNIT_TYPES[id]!, o as UnitStatsOverride);
        if (merged.minRange > merged.maxRange)
          errors.push(`${p}: minRange ${merged.minRange} > maxRange ${merged.maxRange}`);
      }
  }

  if (raw.mechanics !== undefined) {
    if (!isObj(raw.mechanics)) errors.push('mechanics: must be an object');
    else
      for (const [k, v] of Object.entries(raw.mechanics)) {
        if (!(k in DEFAULT_MECHANICS)) errors.push(`mechanics.${k}: unknown constant`);
        else
          checkMechanics(
            errors,
            `mechanics.${k}`,
            (DEFAULT_MECHANICS as unknown as Record<string, unknown>)[k],
            v,
            k,
          );
      }
  }

  if (errors.length) return { ok: false, rules: null, errors };
  return { ok: true, rules: structuredClone(raw) as RulesOverride, errors: [] };
}
