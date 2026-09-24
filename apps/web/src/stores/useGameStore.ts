import { create } from 'zustand';
import type { AttackOutcome, GameAction, GameSettings, GameState, Team } from '@iron-ridge/engine';
import { actingTeam, aiStep, apply, createGame, isAiTurn } from '@iron-ridge/engine';
import type { AttackFx } from '../render/effects.ts';
import { effectVisibility, planAttackFx } from '../render/effects.ts';

const SAVE_KEY = 'iron-ridge-save-v0.9';

export interface UiState {
  selectedMain: string | null;
  selectedArmy: string | null;
  selectedUnit: string | null;
  hoverCell: string | null;
  deployPick: string | null;
  placingFort: boolean;
}

const EMPTY_UI: UiState = {
  selectedMain: null,
  selectedArmy: null,
  selectedUnit: null,
  hoverCell: null,
  deployPick: null,
  placingFort: false,
};

interface GameStore {
  game: GameState | null;
  ui: UiState;
  error: string | null;
  lastOutcome: AttackOutcome | null;
  /** Most recent attack animation plan (id increases per attack). */
  fx: AttackFx | null;
  /** Epoch ms until the current attack animation finishes — the AI waits for it. */
  fxBusyUntil: number;
  handoff: Team | null;
  aiSpeed: number;
  newGame: (settings: GameSettings) => void;
  loadSaved: () => boolean;
  hasSave: () => boolean;
  quit: () => void;
  dispatch: (action: GameAction) => boolean;
  aiTick: () => void;
  setUi: (patch: Partial<UiState>) => void;
  clearError: () => void;
  dismissHandoff: () => void;
  setAiSpeed: (ms: number) => void;
}

function save(game: GameState | null): void {
  try {
    if (game) localStorage.setItem(SAVE_KEY, JSON.stringify(game));
    else localStorage.removeItem(SAVE_KEY);
  } catch {
    // Storage may be unavailable (private mode, previews) — saving is best-effort.
  }
}

/** Which team's view (fog of war) the screen should show. Null = omniscient spectator. */
export function viewTeam(game: GameState): Team | null {
  const { A, B } = game.settings.controllers;
  if (!game.settings.fog) return null;
  if (A === 'human' && B === 'ai') return 'A';
  if (B === 'human' && A === 'ai') return 'B';
  if (A === 'human' && B === 'human') return actingTeam(game);
  return null;
}

function needsHandoff(prev: GameState, next: GameState): Team | null {
  const { A, B } = next.settings.controllers;
  if (A !== 'human' || B !== 'human' || !next.settings.fog) return null;
  const before = actingTeam(prev);
  const after = actingTeam(next);
  return after && before !== after ? after : null;
}

/** Store fields for a new attack: outcome, animation plan, and when it will finish. */
function attackPatch(
  prev: GameState,
  next: GameState,
  outcome: AttackOutcome,
  lastFx: AttackFx | null,
): Pick<GameStore, 'lastOutcome' | 'fx' | 'fxBusyUntil'> {
  const attacker = prev.battle?.units.find((u) => u.id === outcome.attackerId);
  if (!attacker) return { lastOutcome: outcome, fx: lastFx, fxBusyUntil: 0 };
  const target = prev.battle!.units.find((u) => u.pos === outcome.target && u.hp > 0) ?? null;
  const fx = planAttackFx(
    outcome,
    attacker.typeId,
    (lastFx?.id ?? 0) + 1,
    effectVisibility(prev, next, viewTeam(next)),
    target?.id ?? null,
  );
  // The AI resumes once the round has landed (numbers keep floating meanwhile).
  return { lastOutcome: outcome, fx, fxBusyUntil: Date.now() + (fx.flight + 0.45) * 1000 };
}

export const useGameStore = create<GameStore>((set, get) => ({
  game: null,
  ui: EMPTY_UI,
  error: null,
  lastOutcome: null,
  fx: null,
  fxBusyUntil: 0,
  handoff: null,
  aiSpeed: 220,

  newGame: (settings) => {
    const game = createGame(settings);
    save(game);
    const first =
      settings.controllers.A === 'human' && settings.controllers.B === 'human' && settings.fog
        ? 'A'
        : null;
    set({ game, ui: EMPTY_UI, error: null, lastOutcome: null, handoff: first });
  },

  hasSave: () => {
    try {
      return localStorage.getItem(SAVE_KEY) !== null;
    } catch {
      return false;
    }
  },

  loadSaved: () => {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const game = JSON.parse(raw) as GameState;
      if (!game.version?.startsWith('0.9')) return false;
      set({ game, ui: EMPTY_UI, error: null, handoff: null });
      return true;
    } catch {
      return false;
    }
  },

  quit: () => set({ game: null, ui: EMPTY_UI, error: null, handoff: null, lastOutcome: null }),

  dispatch: (action) => {
    const { game } = get();
    if (!game) return false;
    const res = apply(game, action);
    if (res.error) {
      set({ error: res.error });
      return false;
    }
    save(res.state);
    const patch: Partial<GameStore> = { game: res.state, error: null };
    if (res.outcome) Object.assign(patch, attackPatch(game, res.state, res.outcome, get().fx));
    const ho = needsHandoff(game, res.state);
    if (ho) patch.handoff = ho;
    // Leaving a battle / phase change invalidates tactical selection.
    if (res.state.phase !== game.phase)
      patch.ui = { ...get().ui, selectedUnit: null, deployPick: null, placingFort: false };
    set(patch);
    return true;
  },

  aiTick: () => {
    const { game } = get();
    if (!game || !isAiTurn(game)) return;
    const action = aiStep(game);
    const res = apply(game, action);
    let next = res.state;
    if (res.error) {
      const fallback: GameAction =
        game.phase === 'battle'
          ? game.battle?.phase === 'deploy'
            ? { type: 'finishDeploy' }
            : { type: 'endBattleTurn' }
          : { type: 'endTurn' };
      next = apply(game, fallback).state;
    }
    save(next);
    const patch: Partial<GameStore> = { game: next };
    if (res.outcome) Object.assign(patch, attackPatch(game, next, res.outcome, get().fx));
    if (next.phase !== game.phase)
      patch.ui = { ...get().ui, selectedUnit: null, deployPick: null, placingFort: false };
    set(patch);
  },

  setUi: (p) => set({ ui: { ...get().ui, ...p } }),
  clearError: () => set({ error: null }),
  dismissHandoff: () => set({ handoff: null }),
  setAiSpeed: (ms) => set({ aiSpeed: ms }),
}));
