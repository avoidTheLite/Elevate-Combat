// ── Unit catalogue ───────────────────────────────────────────────────────────
// Qualitative data (armor class, damage type, attack type, placement category,
// special rules) comes verbatim from docs/iron-ridge-units.json (copied to
// ./data/units.json; a test keeps them in sync). Numeric stats below are V0.9
// assumptions — the docs deliberately leave numbers "TBD" — see docs/V0.9_ASSUMPTIONS.md.

import unitsJson from './data/units.json' with { type: 'json' };
import type { DicePool } from './rng.ts';

export type Era = 'medieval' | 'ww2';
export type ArmorClass = 'unarmored' | 'light_armor' | 'heavy_armor';
export type DamageType = 'piercing' | 'non_piercing' | 'siege';
export type AttackType = 'melee' | 'ranged_direct' | 'indirect';
export type UnitClass = 'infantry' | 'cavalry' | 'artillery' | 'vehicle';
export type PlacementCategory = 'automatic' | 'warned' | 'combat_fixed' | 'combat_mobile';
export type Effectiveness = 'high' | 'medium' | 'low' | 'none';
export type RangeProfile = 'rifle_mg' | 'at_gun' | 'tank_cannon' | 'indirect' | 'melee';

export interface UnitDef {
  id: string;
  name: string;
  era: Era;
  unitClass: UnitClass;
  armorClass: ArmorClass;
  damageType: DamageType;
  attackType: AttackType;
  role: string;
  specialRules: string[];
  placementCategory: PlacementCategory;
  notes: string;
}

export interface UnitStats {
  short: string;
  hp: number;
  move: number;
  vision: number;
  minRange: number;
  maxRange: number;
  profile: RangeProfile;
  direct: DicePool;
  splash: DicePool | null;
  splashRadius: number;
  /** Command-point cost to recruit. */
  cost: number;
  /** Max terrain step (height levels) the unit can climb in one move. */
  maxClimb: number;
  /** Eye height above terrain for LOS. */
  eye: number;
  suppresses?: boolean;
  firstStrike?: boolean;
  charge?: boolean;
  braced?: boolean;
  engineer?: boolean;
}

export type UnitType = UnitDef & UnitStats;

interface RawUnit {
  id: string;
  name: string;
  unitClass: string;
  armorClass: string;
  damageType: string;
  attackType: string;
  role: string;
  specialRules: string[];
  placementCategory: string;
  notes: string;
}

const pool = (count: number, sides: number, bonus = 0): DicePool => ({ count, sides, bonus });

const STATS: Record<string, UnitStats> = {
  // ── Medieval ──
  med_infantry: {
    short: 'INF',
    hp: 12,
    move: 4,
    vision: 6,
    minRange: 1,
    maxRange: 1,
    profile: 'melee',
    direct: pool(1, 6, 2),
    splash: null,
    splashRadius: 0,
    cost: 3,
    maxClimb: 2,
    eye: 0.5,
  },
  med_archers: {
    short: 'ARC',
    hp: 8,
    move: 4,
    vision: 7,
    minRange: 2,
    maxRange: 6,
    profile: 'rifle_mg',
    // Slightly stronger than the first pass so first-strike remains meaningful once
    // fort / suppression / facing apply to the volley TN (same as meleeStrike).
    direct: pool(1, 6, 2),
    splash: null,
    splashRadius: 0,
    cost: 4,
    maxClimb: 2,
    eye: 0.5,
    firstStrike: true,
  },
  med_horseman: {
    short: 'CAV',
    hp: 12,
    move: 7,
    vision: 7,
    minRange: 1,
    maxRange: 1,
    profile: 'melee',
    direct: pool(1, 8, 1),
    splash: null,
    splashRadius: 0,
    cost: 5,
    maxClimb: 2,
    eye: 0.8,
    charge: true,
  },
  med_spearman: {
    short: 'SPR',
    hp: 12,
    move: 4,
    vision: 6,
    minRange: 1,
    maxRange: 1,
    profile: 'melee',
    direct: pool(1, 6, 2),
    splash: null,
    splashRadius: 0,
    cost: 4,
    maxClimb: 2,
    eye: 0.5,
    braced: true,
  },
  med_artillery: {
    short: 'CAT',
    hp: 10,
    move: 2,
    vision: 4,
    minRange: 3,
    maxRange: 12,
    profile: 'indirect',
    direct: pool(2, 6, 2),
    splash: pool(1, 6),
    splashRadius: 1,
    cost: 7,
    maxClimb: 1,
    eye: 0.6,
  },
  med_engineer: {
    short: 'ENG',
    hp: 8,
    move: 4,
    vision: 5,
    minRange: 1,
    maxRange: 1,
    profile: 'melee',
    direct: pool(1, 4),
    splash: null,
    splashRadius: 0,
    cost: 4,
    maxClimb: 2,
    eye: 0.5,
    engineer: true,
  },
  // ── WW2 ──
  ww2_rifle_infantry: {
    short: 'RIF',
    hp: 10,
    move: 4,
    vision: 7,
    minRange: 1,
    maxRange: 8,
    profile: 'rifle_mg',
    direct: pool(1, 6),
    splash: null,
    splashRadius: 0,
    cost: 3,
    maxClimb: 2,
    eye: 0.5,
  },
  ww2_at_infantry: {
    short: 'BAZ',
    hp: 8,
    move: 4,
    vision: 6,
    minRange: 1,
    maxRange: 5,
    profile: 'at_gun',
    direct: pool(2, 6, 2),
    splash: pool(1, 6),
    splashRadius: 0,
    cost: 4,
    maxClimb: 2,
    eye: 0.5,
  },
  ww2_machine_gun: {
    short: 'MG',
    hp: 10,
    move: 3,
    vision: 7,
    minRange: 1,
    maxRange: 8,
    profile: 'rifle_mg',
    direct: pool(1, 6, 1),
    splash: null,
    splashRadius: 0,
    cost: 4,
    maxClimb: 2,
    eye: 0.5,
    suppresses: true,
  },
  ww2_mortar: {
    short: 'MOR',
    hp: 8,
    move: 3,
    vision: 5,
    minRange: 2,
    maxRange: 10,
    profile: 'indirect',
    direct: pool(2, 6, 1),
    splash: pool(2, 6, 1),
    splashRadius: 1,
    cost: 5,
    maxClimb: 2,
    eye: 0.5,
  },
  ww2_tank: {
    short: 'TNK',
    hp: 18,
    move: 5,
    vision: 6,
    minRange: 2,
    maxRange: 12,
    profile: 'tank_cannon',
    direct: pool(3, 6, 3),
    splash: pool(2, 6),
    splashRadius: 1,
    cost: 10,
    maxClimb: 1,
    eye: 1.0,
  },
  ww2_at_gun: {
    short: 'ATG',
    hp: 12,
    move: 2,
    vision: 6,
    minRange: 1,
    maxRange: 12,
    profile: 'at_gun',
    direct: pool(3, 6, 3),
    splash: pool(1, 6),
    splashRadius: 0,
    cost: 6,
    maxClimb: 1,
    eye: 0.6,
  },
  ww2_light_armored_vehicle: {
    short: 'LAV',
    hp: 14,
    move: 7,
    vision: 7,
    minRange: 1,
    maxRange: 8,
    profile: 'at_gun',
    direct: pool(2, 6),
    splash: null,
    splashRadius: 0,
    cost: 7,
    maxClimb: 1,
    eye: 0.9,
  },
  ww2_artillery: {
    short: 'ART',
    hp: 12,
    move: 4,
    vision: 4,
    minRange: 4,
    maxRange: 18,
    profile: 'indirect',
    direct: pool(3, 8, 4),
    splash: pool(3, 8),
    splashRadius: 1,
    cost: 9,
    maxClimb: 1,
    eye: 0.8,
  },
  ww2_engineer: {
    short: 'ENG',
    hp: 8,
    move: 4,
    vision: 5,
    minRange: 1,
    maxRange: 3,
    profile: 'rifle_mg',
    direct: pool(1, 4),
    splash: null,
    splashRadius: 0,
    cost: 4,
    maxClimb: 2,
    eye: 0.5,
    engineer: true,
  },
};

// Engineers are referenced by the core-mechanics doc (tactical fortification) but
// are not in the units JSON; they are defined here as a V0.9 assumption.
const ENGINEERS: RawUnit[] = [
  {
    id: 'med_engineer',
    name: 'Sappers (Engineers)',
    unitClass: 'infantry',
    armorClass: 'unarmored',
    damageType: 'non_piercing',
    attackType: 'melee',
    role: 'Digs earthworks during battle; fortifications persist into the strategic layer',
    specialRules: ['Dig In: raise fortification on its hex (+1 level, max 3)'],
    placementCategory: 'combat_mobile',
    notes: 'V0.9 assumption — not in iron-ridge-units.json',
  },
  {
    id: 'ww2_engineer',
    name: 'Combat Engineers',
    unitClass: 'infantry',
    armorClass: 'unarmored',
    damageType: 'non_piercing',
    attackType: 'ranged_direct',
    role: 'Digs trenches/sandbags during battle; fortifications persist into the strategic layer',
    specialRules: ['Dig In: raise fortification on its hex (+1 level, max 3)'],
    placementCategory: 'combat_mobile',
    notes: 'V0.9 assumption — not in iron-ridge-units.json',
  },
];

function toType(raw: RawUnit, era: Era): UnitType {
  const stats = STATS[raw.id];
  if (!stats) throw new Error(`No stats for unit ${raw.id}`);
  return {
    id: raw.id,
    name: raw.name,
    era,
    unitClass: raw.unitClass as UnitClass,
    armorClass: raw.armorClass as ArmorClass,
    damageType: raw.damageType as DamageType,
    attackType: raw.attackType as AttackType,
    role: raw.role,
    specialRules: raw.specialRules,
    placementCategory: raw.placementCategory as PlacementCategory,
    notes: raw.notes,
    ...stats,
  };
}

export const UNIT_TYPES: Record<string, UnitType> = {};
for (const u of unitsJson.medieval.units as RawUnit[]) UNIT_TYPES[u.id] = toType(u, 'medieval');
for (const u of unitsJson.ww2.units as RawUnit[]) UNIT_TYPES[u.id] = toType(u, 'ww2');
UNIT_TYPES.med_engineer = toType(ENGINEERS[0]!, 'medieval');
UNIT_TYPES.ww2_engineer = toType(ENGINEERS[1]!, 'ww2');

export function unitType(id: string): UnitType {
  const t = UNIT_TYPES[id];
  if (!t) throw new Error(`Unknown unit type ${id}`);
  return t;
}

export function unitsForEra(era: Era): UnitType[] {
  return Object.values(UNIT_TYPES).filter((u) => u.era === era);
}

// ── Damage-type matrix (from units JSON) ──

const EFFECT_MULT: Record<Effectiveness, number> = { high: 1, medium: 0.75, low: 0.5, none: 0 };

export function effectiveness(dt: DamageType, ac: ArmorClass): Effectiveness {
  const table = unitsJson.damageTypes[dt].effectiveness as Record<string, string>;
  return table[`vs_${ac}`] as Effectiveness;
}

export function effectivenessMultiplier(dt: DamageType, ac: ArmorClass): number {
  return EFFECT_MULT[effectiveness(dt, ac)];
}

/** Siege vs a fortification — the only damage type that can reduce one. */
export function damagesFortification(dt: DamageType): boolean {
  return unitsJson.damageTypes[dt].vs_fortification !== 'none';
}

export function isHighVariance(dt: DamageType): boolean {
  return unitsJson.damageTypes[dt].variance === 'high';
}

export const STARTING_ARMY: Record<Era, string[]> = {
  medieval: [
    'med_infantry',
    'med_infantry',
    'med_spearman',
    'med_archers',
    'med_horseman',
    'med_engineer',
  ],
  ww2: [
    'ww2_rifle_infantry',
    'ww2_rifle_infantry',
    'ww2_machine_gun',
    'ww2_at_infantry',
    'ww2_tank',
    'ww2_engineer',
  ],
};
