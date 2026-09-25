// ── Balance lab: editable forms <-> RulesOverride (pure, no React) ───────────
// A card edits a *form* (strings for numeric inputs so partial typing works).
// Saving turns the form into the minimal UnitStatsOverride vs the code baseline,
// so an untouched unit contributes nothing and the JSON stays small.

import type {
  DicePool,
  Mechanics,
  MechanicsOverride,
  RangeProfile,
  RulesOverride,
  UnitStats,
  UnitStatsOverride,
  UnitType,
} from '@iron-ridge/engine';
import {
  DEFAULT_MECHANICS,
  baseUnitType,
  mergeUnitStats,
  validateRulesOverride,
} from '@iron-ridge/engine';

export const NUM_FIELDS = [
  'hp',
  'move',
  'vision',
  'minRange',
  'maxRange',
  'splashRadius',
  'cost',
  'maxClimb',
  'eye',
] as const;
export type NumField = (typeof NUM_FIELDS)[number];

export const FLAG_FIELDS = ['suppresses', 'firstStrike', 'charge', 'braced', 'engineer'] as const;
export type FlagField = (typeof FLAG_FIELDS)[number];

export const PROFILES: RangeProfile[] = ['rifle_mg', 'at_gun', 'tank_cannon', 'indirect', 'melee'];

export const POOL_FIELDS = ['count', 'sides', 'bonus'] as const;
export type PoolField = (typeof POOL_FIELDS)[number];
export type PoolForm = Record<PoolField, string>;

/** Editable state of one unit card. */
export interface UnitForm {
  short: string;
  nums: Record<NumField, string>;
  profile: RangeProfile;
  direct: PoolForm;
  hasSplash: boolean;
  splash: PoolForm;
  flags: Record<FlagField, boolean>;
}

/** Splash pool a unit without splash starts from (matches engine mergeUnitStats). */
export const DEFAULT_SPLASH: DicePool = { count: 1, sides: 6, bonus: 0 };

export const FIELD_LABEL: Record<NumField | FlagField, string> = {
  hp: 'HP',
  move: 'MOVE',
  vision: 'VISION',
  minRange: 'MIN RNG',
  maxRange: 'MAX RNG',
  splashRadius: 'SPLASH R',
  cost: 'COST',
  maxClimb: 'CLIMB',
  eye: 'EYE',
  suppresses: 'SUPPRESSES',
  firstStrike: 'FIRST STRIKE',
  charge: 'CHARGE',
  braced: 'BRACED',
  engineer: 'ENGINEER',
};

const poolForm = (p: DicePool): PoolForm => ({
  count: String(p.count),
  sides: String(p.sides),
  bonus: String(p.bonus),
});

/** The form for a unit with `override` applied on top of the code baseline. */
export function unitForm(typeId: string, override?: UnitStatsOverride): UnitForm {
  const s: UnitStats = mergeUnitStats(baseUnitType(typeId), override);
  return {
    short: s.short,
    nums: Object.fromEntries(NUM_FIELDS.map((f) => [f, String(s[f])])) as Record<NumField, string>,
    profile: s.profile,
    direct: poolForm(s.direct),
    hasSplash: s.splash !== null,
    splash: poolForm(s.splash ?? DEFAULT_SPLASH),
    flags: Object.fromEntries(FLAG_FIELDS.map((f) => [f, s[f] === true])) as Record<
      FlagField,
      boolean
    >,
  };
}

function parseNum(errors: string[], path: string, raw: string): number {
  const t = raw.trim();
  const n = t === '' ? NaN : Number(t);
  if (!Number.isFinite(n)) errors.push(`${path}: must be a number`);
  return n;
}

export interface FormResult {
  /** Minimal override vs the code baseline; undefined = identical to baseline. */
  override: UnitStatsOverride | undefined;
  errors: string[];
}

/**
 * Turn a card form into the minimal override vs the code baseline and validate
 * it with the engine's `validateRulesOverride` (bounds, minRange ≤ maxRange…).
 */
export function formToOverride(typeId: string, form: UnitForm): FormResult {
  const base: UnitType = baseUnitType(typeId);
  const errors: string[] = [];
  const p = `units.${typeId}`;
  const o: UnitStatsOverride = {};

  if (form.short !== base.short) o.short = form.short;
  for (const f of NUM_FIELDS) {
    const n = parseNum(errors, `${p}.${f}`, form.nums[f]);
    if (Number.isFinite(n) && n !== base[f]) o[f] = n;
  }
  if (form.profile !== base.profile) o.profile = form.profile;

  const direct: Partial<DicePool> = {};
  for (const k of POOL_FIELDS) {
    const n = parseNum(errors, `${p}.direct.${k}`, form.direct[k]);
    if (Number.isFinite(n) && n !== base.direct[k]) direct[k] = n;
  }
  if (Object.keys(direct).length) o.direct = direct;

  if (!form.hasSplash) {
    if (base.splash !== null) o.splash = null;
  } else {
    const from = base.splash ?? DEFAULT_SPLASH;
    const splash: Partial<DicePool> = {};
    for (const k of POOL_FIELDS) {
      const n = parseNum(errors, `${p}.splash.${k}`, form.splash[k]);
      // A unit without splash needs the full pool, or an empty diff would drop it.
      if (Number.isFinite(n) && (base.splash === null || n !== from[k])) splash[k] = n;
    }
    if (Object.keys(splash).length) o.splash = splash;
  }

  for (const f of FLAG_FIELDS) {
    const baseOn = base[f] === true;
    if (form.flags[f] !== baseOn) o[f] = form.flags[f];
  }

  if (errors.length) return { override: undefined, errors };
  if (Object.keys(o).length === 0) return { override: undefined, errors: [] };
  const v = validateRulesOverride({ units: { [typeId]: o } });
  if (!v.ok) return { override: undefined, errors: v.errors };
  return { override: o, errors: [] };
}

/** Keys of `form` whose values differ from `other` (for highlighting). */
export function changedFields(form: UnitForm, other: UnitForm): Set<string> {
  const out = new Set<string>();
  if (form.short !== other.short) out.add('short');
  for (const f of NUM_FIELDS) if (Number(form.nums[f]) !== Number(other.nums[f])) out.add(f);
  if (form.profile !== other.profile) out.add('profile');
  for (const k of POOL_FIELDS) {
    if (Number(form.direct[k]) !== Number(other.direct[k])) out.add(`direct.${k}`);
    if (form.hasSplash && Number(form.splash[k]) !== Number(other.splash[k]))
      out.add(`splash.${k}`);
  }
  if (form.hasSplash !== other.hasSplash) out.add('hasSplash');
  for (const f of FLAG_FIELDS) if (form.flags[f] !== other.flags[f]) out.add(f);
  return out;
}

export function formsEqual(a: UnitForm, b: UnitForm): boolean {
  return changedFields(a, b).size === 0;
}

// ── Mechanics: flattened leaf paths ("BASE_TN.unarmored", "FACING_MODS.front.tn") ──

export type MechForm = Record<string, string>;

function leaves(o: unknown, prefix: string, out: Record<string, number>): void {
  if (typeof o === 'number') {
    out[prefix] = o;
    return;
  }
  for (const [k, v] of Object.entries(o as Record<string, unknown>))
    leaves(v, prefix ? `${prefix}.${k}` : k, out);
}

/** Every numeric mechanics leaf with its baseline value, in declaration order. */
export function mechanicsLeaves(
  m: Readonly<Mechanics> = DEFAULT_MECHANICS,
): Record<string, number> {
  const out: Record<string, number> = {};
  leaves(m, '', out);
  return out;
}

function getPath(o: unknown, path: string): unknown {
  let cur = o;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function mechForm(override?: MechanicsOverride): MechForm {
  const base = mechanicsLeaves();
  const out: MechForm = {};
  for (const [path, v] of Object.entries(base)) {
    const o = getPath(override, path);
    out[path] = String(typeof o === 'number' ? o : v);
  }
  return out;
}

export interface MechResult {
  override: MechanicsOverride | undefined;
  errors: string[];
}

/** Minimal nested mechanics override vs DEFAULT_MECHANICS, validated. */
export function mechFormToOverride(form: MechForm): MechResult {
  const base = mechanicsLeaves();
  const errors: string[] = [];
  const o: Record<string, unknown> = {};
  for (const [path, b] of Object.entries(base)) {
    const n = parseNum(errors, `mechanics.${path}`, form[path] ?? '');
    if (!Number.isFinite(n) || n === b) continue;
    const keys = path.split('.');
    let cur = o;
    for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
    cur[keys[keys.length - 1]!] = n;
  }
  if (errors.length) return { override: undefined, errors };
  if (Object.keys(o).length === 0) return { override: undefined, errors: [] };
  const v = validateRulesOverride({ mechanics: o });
  if (!v.ok) return { override: undefined, errors: v.errors };
  return { override: o as MechanicsOverride, errors: [] };
}

// ── Whole-page draft ──

/** Drop empty sections so "no changes" is `{}` and compares cleanly. */
export function normalizeRules(r: RulesOverride | undefined): RulesOverride {
  const out: RulesOverride = {};
  if (r?.units) {
    const units = Object.fromEntries(
      Object.entries(r.units).filter(([, o]) => o && Object.keys(o).length > 0),
    );
    if (Object.keys(units).length) out.units = units;
  }
  if (r?.mechanics && Object.keys(r.mechanics).length) out.mechanics = r.mechanics;
  return out;
}

export function isEmptyRules(r: RulesOverride | undefined): boolean {
  const n = normalizeRules(r);
  return !n.units && !n.mechanics;
}

/** Count of overridden units + mechanics leaves (for badges). */
export function rulesChangeCount(r: RulesOverride | undefined): number {
  const n = normalizeRules(r);
  const units = Object.keys(n.units ?? {}).length;
  const mech = n.mechanics ? Object.keys(mechanicsLeavesOf(n.mechanics)).length : 0;
  return units + mech;
}

function mechanicsLeavesOf(o: MechanicsOverride): Record<string, number> {
  const out: Record<string, number> = {};
  leaves(o, '', out);
  return out;
}
