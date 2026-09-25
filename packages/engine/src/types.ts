import type { HexKey } from './hex.ts';
import type { GridConfig } from './grid.ts';
import type { Era } from './units.ts';
import type { RulesOverride } from './rules.ts';

export type Team = 'A' | 'B';

export const TEAM_NAME: Record<Team, string> = { A: 'ALPHA', B: 'BRAVO' };

export function otherTeam(t: Team): Team {
  return t === 'A' ? 'B' : 'A';
}

// ── Persistent unit (lives in a strategic army between battles) ──

export interface ArmyUnit {
  id: string;
  typeId: string;
  label: string;
  hp: number;
}

/** A strategic unit holder: a mobile commander, or a garrison bound to a building. */
export type HolderKind = 'commander' | 'garrison';

/** Buildings that host a garrison. V1.0 has only the HQ. */
export type BuildingKind = 'hq';

/**
 * A strategic holder of units. Commanders move on the sub-hex grid; garrisons sit
 * on their building's sub-hex and never move. (Named `Army` for V0.9 continuity.)
 */
export interface Army {
  id: string;
  team: Team;
  kind: HolderKind;
  /** Sub-hex the holder stands on. */
  pos: HexKey;
  /** Main hex containing `pos` — always kept in sync via `setHolderPos`. */
  at: HexKey;
  /** Garrisons only: the building they belong to. */
  building?: BuildingKind;
  units: ArmyUnit[];
  /** Strategic sub-hex steps left this turn (always 0 for garrisons). */
  movesLeft: number;
}

/** V1 alias — the plan's name for commanders and garrisons alike. */
export type Holder = Army;

/**
 * Who may swap units: holders within `radius` sub-hexes (null = no radius check)
 * and/or in the same main hex. Both checks are on by default.
 */
export interface TransferRule {
  radius: number | null;
  sameMainHex: boolean;
}

// ── Tactical battle ──

export type BattlePhase = 'deploy' | 'combat' | 'over';

export interface BattleUnit {
  id: string;
  typeId: string;
  label: string;
  team: Team;
  hp: number;
  maxHp: number;
  pos: HexKey | null; // null until deployed
  facing: number; // 0..5 direction index
  mp: number;
  moved: boolean;
  /** Distance moved this turn (cavalry charge). */
  movedDist: number;
  acted: boolean;
  /** combat_fixed units: set up and able to fire, but cannot move. */
  deployed: boolean;
  suppressed: boolean;
  /**
   * Fire-exposed: shot recently, so the enemy player still has this unit
   * *revealed* until the start of its own turn even without LOS.
   * (Player-facing "do I know about them?" is computed via `revealedEnemies`.)
   */
  exposed: boolean;
  firstStrikeUsed: boolean;
}

export interface BattleLogEntry {
  round: number;
  team: Team;
  text: string;
  kind: 'info' | 'hit' | 'miss' | 'kill' | 'system';
}

/** Map/scenario battle objective — chosen when the campaign is seeded. */
export type BattleObjectiveKind = 'hold_contested' | 'capture_point';

export interface BattleObjective {
  kind: BattleObjectiveKind;
  /**
   * Sub-hex of the designated capture point. When omitted, the contested main-hex
   * centre is used. Future maps can place this anywhere on the battle footprint.
   */
  captureKey?: HexKey;
  /** Extra ring around the capture point that must be clear of defenders. */
  captureRadius: number;
  /** Attacker origin main-hex is the extraction zone for a successful pull-out. */
  extractionAtOrigin: boolean;
}

export interface Battle {
  id: string;
  era: Era;
  attacker: Team;
  defender: Team;
  attackerArmyId: string;
  defenderArmyId: string;
  /** Main hex being fought over. */
  contested: HexKey;
  /** Main hex the attack came from. */
  origin: HexKey;
  /** Main hexes whose sub-cells make up the battle map. */
  mains: HexKey[];
  phase: BattlePhase;
  deployTeam: Team;
  round: number;
  maxRounds: number;
  active: Team;
  units: BattleUnit[];
  /** Fortification level per sub-hex (0–3). Copied from and written back to strategy. */
  forts: Record<HexKey, number>;
  warningTurns: number;
  /** Warned-category fortifications the defender may still place during deployment. */
  warnedPlacements: number;
  warnedRange: number;
  /** Resolved objective for this battle (from settings / map seed). */
  objective: BattleObjective;
  /** Attacker chose EXTRACT after securing the capture point — survivors return to origin. */
  extracted: boolean;
  log: BattleLogEntry[];
  winner: Team | null;
  endReason: string | null;
}

// ── Strategic campaign ──

export interface MainHexState {
  owner: Team | null;
  /** Consecutive defender turns with an enemy army adjacent (warning clock). */
  warning: number;
}

export type Controller = 'human' | 'ai';

export interface GameSettings {
  era: Era;
  grid: GridConfig;
  seed: number;
  controllers: Record<Team, Controller>;
  fog: boolean;
  battleRounds: number;
  /** Optional overrides; omitted fields use V0.9 defaults per map/seed. */
  battleObjective?: Partial<BattleObjective>;
  /** Optional transfer-rule override; omitted fields use `COMMAND.transferRule`. */
  transferRule?: Partial<TransferRule>;
  /** Runtime unit/mechanics overrides (balance lab). Absent = baseline rules. */
  rules?: RulesOverride;
}

export interface StrategicLogEntry {
  turn: number;
  team: Team;
  text: string;
}

export type GamePhase = 'strategic' | 'battle-pending' | 'battle' | 'over';

export interface PendingBattle {
  attackerArmyId: string;
  defenderArmyId: string;
  origin: HexKey;
  target: HexKey;
}

export interface GameState {
  version: string;
  settings: GameSettings;
  phase: GamePhase;
  turn: number;
  active: Team;
  cp: Record<Team, number>;
  hq: Record<Team, HexKey>;
  hexes: Record<HexKey, MainHexState>;
  armies: Army[];
  /** Sub-hex fortification levels (persist between battles). */
  forts: Record<HexKey, number>;
  pending: PendingBattle | null;
  battle: Battle | null;
  log: StrategicLogEntry[];
  winner: Team | null;
  rng: number;
  nextId: number;
}
