import { create } from 'zustand';
import type { AttackOutcome, GameAction, GameSettings, GameState, Team } from '@iron-ridge/engine';
import { actingTeam, aiStep, apply, createGame, isAiTurn } from '@iron-ridge/engine';
import type { AttackFx } from '../render/effects.ts';
import { effectVisibility, planAttackFx } from '../render/effects.ts';

const SAVE_KEY = 'iron-ridge-save-v0.9';

export interface UiState {
  selectedMain: string | null;
  /** Selected strategic holder (commander or garrison) — own or a visible enemy. */
  selectedArmy: string | null;
  /** Units ticked in the Contents panel (ids inside the selected holder). */
  checkedUnits: string[];
  selectedUnit: string | null;
  hoverCell: string | null;
  deployPick: string | null;
  placingFort: boolean;
}

const EMPTY_UI: UiState = {
  selectedMain: null,
  selectedArmy: null,
  checkedUnits: [],
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
  /** Quit dialog: choose abandon vs save-and-quit. */
  quitPrompt: boolean;
  newGame: (settings: GameSettings) => void;
  loadSaved: () => boolean;
  hasSave: () => boolean;
  requestQuit: () => void;
  cancelQuit: () => void;
  /** Keep autosave and return to setup. */
  saveAndQuit: () => void;
  /** Wipe autosave and return to setup. */
  abandon: () => void;
  /** @deprecated prefer saveAndQuit / abandon — kept for tests that clear store state. */
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

/** Lightweight structural guard — accepts unknown extra fields. */
export function isValidSave(raw: unknown): raw is GameState {
  if (!raw || typeof raw !== 'object') return false;
  const g = raw as Record<string, unknown>;
  if (typeof g.version !== 'string' || !g.version.startsWith('0.9')) return false;
  if (!g.settings || typeof g.settings !== 'object') return false;
  const settings = g.settings as Record<string, unknown>;
  if (typeof settings.era !== 'string' || !settings.grid || typeof settings.grid !== 'object')
    return false;
  if (!settings.controllers || typeof settings.controllers !== 'object') return false;
  if (typeof g.phase !== 'string') return false;
  if (typeof g.turn !== 'number' || typeof g.active !== 'string') return false;
  if (!g.cp || typeof g.cp !== 'object') return false;
  if (!g.hq || typeof g.hq !== 'object') return false;
  if (!g.hexes || typeof g.hexes !== 'object') return false;
  if (!Array.isArray(g.armies)) return false;
  if (!g.forts || typeof g.forts !== 'object') return false;
  if (typeof g.rng !== 'number' || typeof g.nextId !== 'number') return false;
  return true;
}

function clearSession(): Pick<
  GameStore,
  'game' | 'ui' | 'error' | 'handoff' | 'lastOutcome' | 'fx' | 'fxBusyUntil' | 'quitPrompt'
> {
  return {
    game: null,
    ui: EMPTY_UI,
    error: null,
    handoff: null,
    lastOutcome: null,
    fx: null,
    fxBusyUntil: 0,
    quitPrompt: false,
  };
}

function hotseatHandoff(game: GameState): Team | null {
  const { A, B } = game.settings.controllers;
  if (A !== 'human' || B !== 'human' || !game.settings.fog) return null;
  return actingTeam(game);
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
  // Plan FX with the shooter's fog view (prev), not post-resolution actingTeam.
  const fx = planAttackFx(
    outcome,
    attacker.typeId,
    (lastFx?.id ?? 0) + 1,
    effectVisibility(prev, next, viewTeam(prev) ?? attacker.team),
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
  quitPrompt: false,

  newGame: (settings) => {
    const game = createGame(settings);
    save(game);
    const first =
      settings.controllers.A === 'human' && settings.controllers.B === 'human' && settings.fog
        ? 'A'
        : null;
    set({
      ...clearSession(),
      game,
      handoff: first,
    });
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
      const parsed: unknown = JSON.parse(raw);
      if (!isValidSave(parsed)) {
        localStorage.removeItem(SAVE_KEY);
        return false;
      }
      // Older saves may lack battle.objective — fill defaults when a battle is mid-flight.
      if (parsed.battle && !parsed.battle.objective) {
        parsed.battle.objective = {
          kind: 'capture_point',
          captureRadius: 1,
          extractionAtOrigin: true,
        };
        parsed.battle.extracted = parsed.battle.extracted ?? false;
      }
      // Rename legacy BattleUnit.revealed → exposed (FOW terminology realign).
      if (parsed.battle?.units) {
        for (const u of parsed.battle.units as unknown as Array<Record<string, unknown>>) {
          if (!('exposed' in u) && 'revealed' in u) {
            u.exposed = Boolean(u.revealed);
            delete u.revealed;
          }
          if (typeof u.exposed !== 'boolean') u.exposed = false;
        }
      }
      set({
        ...clearSession(),
        game: parsed,
        handoff: hotseatHandoff(parsed),
      });
      return true;
    } catch {
      try {
        localStorage.removeItem(SAVE_KEY);
      } catch {
        /* ignore */
      }
      return false;
    }
  },

  requestQuit: () => set({ quitPrompt: true }),
  cancelQuit: () => set({ quitPrompt: false }),
  saveAndQuit: () => {
    const { game } = get();
    if (game) save(game);
    set(clearSession());
  },
  abandon: () => {
    save(null);
    set(clearSession());
  },
  quit: () => {
    // Soft clear for tests — does not touch localStorage (use abandon / saveAndQuit).
    set(clearSession());
  },

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
    // A new side on turn (hotseat) must not inherit the previous side's selection.
    if (res.state.active !== game.active)
      patch.ui = { ...(patch.ui ?? get().ui), selectedArmy: null, checkedUnits: [] };
    // Ticked units that left the selected holder (transfer, battle) are unticked.
    const ui = patch.ui ?? get().ui;
    const held = res.state.armies.find((a) => a.id === ui.selectedArmy);
    const checked = ui.checkedUnits.filter((id) => held?.units.some((u) => u.id === id));
    if (checked.length !== ui.checkedUnits.length) patch.ui = { ...ui, checkedUnits: checked };
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
      console.warn('[ai] illegal action, falling back', action, res.error);
      const fallback: GameAction =
        game.phase === 'battle'
          ? game.battle?.phase === 'deploy'
            ? { type: 'finishDeploy' }
            : { type: 'endBattleTurn' }
          : { type: 'endTurn' };
      const fb = apply(game, fallback);
      if (fb.error) {
        console.warn('[ai] fallback also failed', fallback, fb.error);
        return;
      }
      next = fb.state;
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
