import { create } from 'zustand';
import type { AttackOutcome, GameAction, GameSettings, GameState, Team } from '@iron-ridge/engine';
import {
  actingTeam,
  aiStep,
  apply,
  createGame,
  deserializeSave,
  isAiTurn,
  serializeSave,
  validateGameState,
} from '@iron-ridge/engine';
import type { AttackFx } from '../render/effects.ts';
import { effectVisibility, planAttackFx } from '../render/effects.ts';
import type { SlotId, SlotInfo } from './saveSlots.ts';
import {
  SLOT_IDS,
  exportFilename,
  migrateLegacyStorage,
  readSlot,
  removeSlot,
  slotInfo,
  slotName,
  writeSlot,
} from './saveSlots.ts';

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
  /** Last save/load failure, shown on the setup screen (never thrown). */
  loadError: string | null;
  /** Short confirmation / migration note after a save or load. */
  saveNotice: string | null;
  /** Bumps whenever a slot is written or deleted (lets slot lists re-read storage). */
  saveRev: number;
  newGame: (settings: GameSettings) => void;
  /** Continue: load the autosave slot. */
  loadSaved: () => boolean;
  hasSave: () => boolean;
  saveToSlot: (slot: SlotId, label?: string) => boolean;
  loadSlot: (slot: SlotId) => boolean;
  deleteSlot: (slot: SlotId) => void;
  listSlots: () => SlotInfo[];
  /** Current game as save-file text plus a suggested download filename. */
  exportSave: () => { text: string; filename: string } | null;
  /** Load save-file text (from an imported .json) into the game and autosave. */
  importSave: (text: string) => boolean;
  /** Move a V0.9 autosave into the V1 autosave slot (runs once at startup). */
  migrateLegacy: () => boolean;
  clearLoadError: () => void;
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

/** Autosave (best-effort; storage may be unavailable in private mode / previews). */
function save(game: GameState | null): void {
  if (game) writeSlot('autosave', game, 'Autosave');
  else removeSlot('autosave');
}

/** Structural guard for a (current-schema) GameState — delegates to the engine. */
export function isValidSave(raw: unknown): raw is GameState {
  return validateGameState(raw).length === 0;
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

/** Store fields for entering a loaded game: fresh session + hotseat hand-off. */
function enterGame(game: GameState, notes: string[] = []): Partial<GameStore> {
  return {
    ...clearSession(),
    game,
    handoff: hotseatHandoff(game),
    loadError: null,
    saveNotice: notes.length ? notes.join(' · ') : null,
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
  loadError: null,
  saveNotice: null,
  saveRev: 0,

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
      loadError: null,
      saveNotice: null,
    });
  },

  hasSave: () => {
    migrateLegacyStorage();
    return readSlot('autosave') !== null;
  },

  loadSaved: () => get().loadSlot('autosave'),

  loadSlot: (slot) => {
    migrateLegacyStorage();
    const text = readSlot(slot);
    if (text === null) {
      if (slot !== 'autosave') set({ loadError: `${slotName(slot)} is empty` });
      return false;
    }
    const r = deserializeSave(text);
    if (!r.ok) {
      removeSlot(slot);
      set({
        loadError: `Save was corrupted and has been removed (${slotName(slot)}): ${r.error}`,
        saveRev: get().saveRev + 1,
      });
      return false;
    }
    if (slot !== 'autosave' || r.migrated.length) save(r.save.state);
    set({ ...enterGame(r.save.state, r.migrated), saveRev: get().saveRev + 1 });
    return true;
  },

  saveToSlot: (slot, label) => {
    const { game } = get();
    if (!game) return false;
    const ok = writeSlot(slot, game, label);
    set({
      saveNotice: ok ? `Saved to ${slotName(slot)}` : null,
      error: ok ? get().error : 'Could not save — browser storage is unavailable or full',
      saveRev: get().saveRev + 1,
    });
    return ok;
  },

  deleteSlot: (slot) => {
    removeSlot(slot);
    set({ saveRev: get().saveRev + 1 });
  },

  listSlots: () => {
    migrateLegacyStorage();
    return SLOT_IDS.map(slotInfo);
  },

  exportSave: () => {
    const { game } = get();
    if (!game) return null;
    return { text: serializeSave(game), filename: exportFilename(game) };
  },

  importSave: (text) => {
    const r = deserializeSave(text);
    if (!r.ok) {
      set({ loadError: `Import failed: ${r.error}` });
      return false;
    }
    save(r.save.state);
    set({ ...enterGame(r.save.state, r.migrated), saveRev: get().saveRev + 1 });
    return true;
  },

  migrateLegacy: () => {
    const r = migrateLegacyStorage();
    if (r.error) set({ loadError: r.error });
    if (r.migrated || r.error) set({ saveRev: get().saveRev + 1 });
    return r.migrated;
  },

  clearLoadError: () => set({ loadError: null }),

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

// First run after the V1.0 upgrade: carry the V0.9 autosave over.
useGameStore.getState().migrateLegacy();
