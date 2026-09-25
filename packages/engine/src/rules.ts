// ── Runtime rules overrides (balance lab / simulator) ────────────────────────
// The unit stat table and the main combat constants can be overridden at runtime
// without a rebuild. An override is plain JSON:
//
//   { units: { ww2_tank: { hp: 20, direct: { bonus: 5 } } },
//     mechanics: { BASE_TN: { unarmored: 14 }, BLIND_FIRE_TN: 5 } }
//
// `withRules(override, fn)` makes an override *active* for the synchronous
// duration of `fn` (nesting-safe, restored in `finally`). `unitType()` and
// `mechanics()` read through the active override. `apply()` wraps every action
// in `withRules(state.settings.rules)`, so a game started with overrides stays
// consistent across save/load.
//
// This module has no value imports from the rest of the engine so that
// units.ts / combat.ts can import it without an import cycle.

import type { DicePool } from './rng.ts';
import type { ArmorClass, Effectiveness, UnitStats } from './units.ts';

export type FacingArcName = 'front' | 'side' | 'rear';

/** Tunable combat constants (docs/Iron_Ridge_Combat_Rules_v1.md section refs in comments). */
export interface Mechanics {
  /** §1 base to-hit TN by target armor class. */
  BASE_TN: Record<ArmorClass, number>;
  /** §2 splash threshold for HE weapons. */
  SPLASH_TN: number;
  /** §7 flat damage reduction by armor class. */
  ARMOR_RATING: Record<ArmorClass, number>;
  /** §5 TN penalty for indirect fire without a spotter. */
  BLIND_FIRE_TN: number;
  /** Maximum fortification level on a sub-hex (tactical layer; see assumptions). */
  MAX_FORT: number;
  /** §7a facing modifiers vs armored targets (TN and damage). */
  FACING_MODS: Record<FacingArcName, { tn: number; dmg: number }>;
  /** Damage-type effectiveness multipliers (high/medium/low/none). */
  EFFECT_MULT: Record<Effectiveness, number>;
  /** TN modifier for direct fire after moving. */
  MOVED_FIRE_TN: number;
  /** TN modifier for direct fire without moving (braced). */
  BRACED_FIRE_TN: number;
  /** TN modifier for marginal line of sight. */
  MARGINAL_LOS_TN: number;
  /** TN modifier when the shooter is suppressed. */
  SUPPRESSED_TN: number;
  /** TN modifier for melee (point-blank) strikes. */
  MELEE_TN: number;
  /** Cavalry charge damage bonus… */
  CHARGE_BONUS: number;
  /** …when it moved at least this far this turn. */
  CHARGE_MIN_MOVE: number;
  /** Cavalry that moved at least this far denies archers' first strike. */
  FIRST_STRIKE_DENY_MOVE: number;
  /** Braced spearmen strike first against cavalry with this damage bonus. */
  SPEAR_BRACE_BONUS: number;
  /** MG near-miss window: a roll ≥ TN − this still suppresses unarmored targets. */
  MG_SUPPRESS_MARGIN: number;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type MechanicsOverride = DeepPartial<Mechanics>;

/** Per-unit stat override. Dice pools may be given partially ({ bonus: 4 }). */
export type UnitStatsOverride = Omit<Partial<UnitStats>, 'direct' | 'splash'> & {
  direct?: Partial<DicePool>;
  splash?: Partial<DicePool> | null;
};

export interface RulesOverride {
  units?: Record<string, UnitStatsOverride>;
  mechanics?: MechanicsOverride;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export const DEFAULT_MECHANICS: Readonly<Mechanics> = deepFreeze({
  BASE_TN: { heavy_armor: 7, light_armor: 10, unarmored: 15 },
  SPLASH_TN: 10,
  ARMOR_RATING: { unarmored: 0, light_armor: 3, heavy_armor: 6 },
  BLIND_FIRE_TN: 6,
  MAX_FORT: 3,
  FACING_MODS: {
    front: { tn: 2, dmg: -2 },
    rear: { tn: 1, dmg: 2 },
    side: { tn: -1, dmg: 0 },
  },
  EFFECT_MULT: { high: 1, medium: 0.75, low: 0.5, none: 0 },
  MOVED_FIRE_TN: 3,
  BRACED_FIRE_TN: -2,
  MARGINAL_LOS_TN: 2,
  SUPPRESSED_TN: 2,
  MELEE_TN: -5,
  CHARGE_BONUS: 2,
  CHARGE_MIN_MOVE: 3,
  FIRST_STRIKE_DENY_MOVE: 4,
  SPEAR_BRACE_BONUS: 3,
  MG_SUPPRESS_MARGIN: 4,
});

// ── Active override ──

let active: RulesOverride | undefined;

/** The override currently in effect (undefined = baseline rules). */
export function activeRules(): RulesOverride | undefined {
  return active;
}

/**
 * Run `fn` with `override` active (undefined = baseline, *not* "inherit").
 * Synchronous only — the previous override is restored in `finally`, so nesting
 * and throwing are safe. Do not pass async functions.
 */
export function withRules<T>(override: RulesOverride | undefined, fn: () => T): T {
  const prev = active;
  active = override;
  try {
    return fn();
  } finally {
    active = prev;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge of plain objects; `over` wins, undefined leaves base untouched. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out as T;
}

const mechanicsCache = new WeakMap<RulesOverride, Mechanics>();

/** Combat constants with the active override applied. */
export function mechanics(): Readonly<Mechanics> {
  const o = active;
  if (!o || !o.mechanics) return DEFAULT_MECHANICS;
  let m = mechanicsCache.get(o);
  if (!m) {
    m = deepMerge(DEFAULT_MECHANICS as Mechanics, o.mechanics);
    mechanicsCache.set(o, m);
  }
  return m;
}

/**
 * Combine two overrides (later wins, deep). Either side may be undefined.
 * Returns undefined when both are.
 */
export function mergeRules(
  a: RulesOverride | undefined,
  b: RulesOverride | undefined,
): RulesOverride | undefined {
  if (!a) return b;
  if (!b) return a;
  return deepMerge(a, b);
}

/**
 * Apply a unit-stat override to a base stat block. Dice pools merge field by
 * field; `splash: null` removes splash; a partial splash on a unit without one
 * starts from { count: 1, sides: 6, bonus: 0 }.
 */
export function mergeUnitStats<T extends UnitStats>(base: T, o: UnitStatsOverride | undefined): T {
  if (!o) return base;
  const { direct, splash, ...rest } = o;
  const out = { ...base, ...(rest as Partial<UnitStats>) } as T;
  if (direct) out.direct = { ...base.direct, ...direct };
  if (splash === null) out.splash = null;
  else if (splash) out.splash = { ...(base.splash ?? { count: 1, sides: 6, bonus: 0 }), ...splash };
  return out;
}
