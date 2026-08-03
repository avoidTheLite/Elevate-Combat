import type { Era, CombatResult, GameState } from './game.ts';

// ── Request / Response shapes for all API endpoints ──────────────────────────

export interface CreateGameBody {
  era: Era;
  teamAName?: string;
  teamBName?: string;
}

export interface AttackBody {
  attackerId: string;
  defenderId: string;
  attackerMoved?: boolean;
  facingMod?: number;
  facingDmg?: number;
  blindFire?: boolean;
}

export interface CreateGameResponse {
  game: GameState;
}

export interface GetGameResponse {
  game: GameState;
}

export interface AttackResponse {
  result: CombatResult;
  game: GameState;
}

export interface EndTurnResponse {
  game: GameState;
}

export interface ResetGameResponse {
  game: GameState;
}
