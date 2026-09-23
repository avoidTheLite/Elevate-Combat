// ── Whose move is it? — shared by the UI loop and headless simulations ───────

import type { GameAction } from './actions.ts';
import { apply } from './actions.ts';
import { aiPendingDecision, strategicAiStep } from './ai/strategicAi.ts';
import { tacticalAiStep } from './ai/tacticalAi.ts';
import type { GameState, Team } from './types.ts';

/** The team whose input the game is waiting on, or null when the game is over. */
export function actingTeam(state: GameState): Team | null {
  if (state.phase === 'over') return null;
  if (state.phase === 'battle' && state.battle) {
    const b = state.battle;
    if (b.phase === 'over') return state.active;
    return b.phase === 'deploy' ? b.deployTeam : b.active;
  }
  return state.active;
}

export function isAiTurn(state: GameState): boolean {
  const team = actingTeam(state);
  if (!team) return false;
  const { A, B } = state.settings.controllers;
  // Pending-battle choices and battle results are shown to any human involved.
  if (
    state.phase === 'battle-pending' ||
    (state.phase === 'battle' && state.battle?.phase === 'over')
  ) {
    return A === 'ai' && B === 'ai';
  }
  return state.settings.controllers[team] === 'ai';
}

export function aiStep(state: GameState): GameAction {
  if (state.phase === 'battle-pending') return aiPendingDecision();
  if (state.phase === 'battle') return tacticalAiStep(state);
  return strategicAiStep(state);
}

/**
 * Run AI actions until a human is needed (or `limit` actions). If the AI ever
 * proposes an illegal action we fall back to ending its turn so play never stalls.
 */
export function runAi(state: GameState, limit = 400): GameState {
  let s = state;
  for (let i = 0; i < limit && isAiTurn(s); i++) {
    const action = aiStep(s);
    const res = apply(s, action);
    if (res.error) {
      const fallback: GameAction =
        s.phase === 'battle'
          ? s.battle?.phase === 'deploy'
            ? { type: 'finishDeploy' }
            : { type: 'endBattleTurn' }
          : { type: 'endTurn' };
      const fb = apply(s, fallback);
      if (fb.error) return s;
      s = fb.state;
    } else s = res.state;
  }
  return s;
}
