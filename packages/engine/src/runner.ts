// ── Whose move is it? — shared by the UI loop and headless simulations ───────

import type { GameAction } from './actions.ts';
import { apply } from './actions.ts';
import { aiPendingDecision, strategicAiStep } from './ai/strategicAi.ts';
import { tacticalAiStep, chooseCampaignFreeShotAiTarget } from './ai/tacticalAi.ts';
import type { GameState, Team } from './types.ts';
import { withRules } from './rules.ts';
import { foundationHasPending, foundationPendingTeam } from './foundation/campaign.ts';
import { currentFoundationCaptureChoices } from './foundation/capture.ts';
import { getFreeShotPrompt } from './foundation/freeShots.ts';

/** The team whose input the game is waiting on, or null when the game is over. */
export function actingTeam(state: GameState): Team | null {
  if (state.phase === 'over') return null;
  const pendingTeam = foundationPendingTeam(state);
  if (pendingTeam) return pendingTeam;
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
  if (foundationHasPending(state)) return state.settings.controllers[team] === 'ai';
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
  return withRules(state.settings.rules, () => {
    const pending = foundationAiStep(state);
    if (pending) return pending;
    if (state.phase === 'battle-pending') return aiPendingDecision();
    if (state.phase === 'battle') return tacticalAiStep(state);
    return strategicAiStep(state);
  });
}

function foundationAiStep(state: GameState): GameAction | null {
  const f = state.infrastructure;
  if (!f) return null;
  const batch = f.capture.pending;
  if (batch) {
    const selected = currentFoundationCaptureChoices(batch);
    const total = selected.reduce(
      (sum, choice) =>
        sum + (choice.request.outcome === 'none' ? 0 : batch.costs[choice.request.outcome]),
      0,
    );
    const open = batch.candidates.find(
      (candidate) => !selected.some((choice) => choice.request.nodeId === candidate.node.id),
    );
    if (open) {
      const remaining = state.cp[batch.team] - total;
      const site = f.sites.find((s) => s.nodeId === open.node.id);
      const outcome =
        remaining >= batch.costs.capture
          ? ('capture' as const)
          : site?.homeTeam && site.homeTeam !== batch.team && remaining >= batch.costs.raze
            ? ('raze' as const)
            : ('none' as const);
      return { type: 'captureChoice', nodeId: open.node.id, outcome };
    }
    if (total > state.cp[batch.team]) {
      const paid = selected.find((choice) => choice.request.outcome !== 'none')!;
      return { type: 'captureChoice', nodeId: paid.request.nodeId, outcome: 'none' };
    }
    return { type: 'captureCommit' };
  }
  if (f.garrisons?.pendingStationing) return { type: 'stationingCommit' };
  if (f.garrisons?.freeShots.pending) {
    const prompt = getFreeShotPrompt(f.garrisons.freeShots);
    if (!prompt.ok || prompt.status === 'complete') return null;
    if (prompt.status === 'selected') return { type: 'freeShotResolve' };
    const targetId = chooseCampaignFreeShotAiTarget(state, prompt);
    if (targetId) return { type: 'freeShotTarget', targetId };
  }
  return null;
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
      if (foundationHasPending(s)) return s;
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
