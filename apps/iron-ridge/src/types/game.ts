// ── Core game types derived from design docs ─────────────────────────────────

export type Era = "medieval" | "ww2";
export type Team = "A" | "B";
export type ArmorClass = "unarmored" | "light_armor" | "heavy_armor";
export type DamageType = "piercing" | "non_piercing" | "siege";
export type AttackType = "melee" | "ranged_direct" | "indirect";
export type UnitClass = "infantry" | "cavalry" | "artillery" | "vehicle";
export type PlacementCategory =
  | "automatic"
  | "warned"
  | "combat_fixed"
  | "combat_mobile";

export type Effectiveness = "high" | "medium" | "low" | "none";

export interface UnitDef {
  id: string;
  name: string;
  unitClass: UnitClass;
  armorClass: ArmorClass;
  damageType: DamageType;
  attackType: AttackType;
  role: string;
  specialRules: string[];
  placementCategory: PlacementCategory;
  notes: string;
}

export interface UnitInstance {
  id: string;
  defId: string;
  team: Team;
  col: number;
  row: number;
  label: string;
  hp: number;
  maxHp: number;
  moved: boolean;
  fired: boolean;
}

// ── Map ──────────────────────────────────────────────────────────────────────

export type HeightMap = number[][];

export interface MapDef {
  id: string;
  name: string;
  cols: number;
  rows: number;
  hm: HeightMap;
}

// ── Combat ───────────────────────────────────────────────────────────────────

export interface CombatResult {
  attackerId: string;
  defenderId: string;
  toHitRoll: number;
  adjustedTN: number;
  hit: boolean;
  splash: boolean;
  damageRoll: number;
  armorReduction: number;
  finalDamage: number;
  log: string[];
}

// ── Game State ───────────────────────────────────────────────────────────────

export type Phase = "setup" | "combat" | "resolution";

export interface GameState {
  era: Era;
  phase: Phase;
  turn: number;
  activeTeam: Team;
  units: UnitInstance[];
  selectedUnitId: string | null;
  combatLog: string[];
}
