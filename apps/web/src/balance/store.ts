// ── Balance lab store: view switch, page draft, active (applied) override ────
// `active` is what new games use (settings.rules); it persists in localStorage
// so tuning survives reloads without a rebuild. `draft` is the page being
// edited; per-card Save commits into it, Apply all promotes it to `active`.

import { create } from 'zustand';
import type {
  GameSettings,
  MechanicsOverride,
  RulesOverride,
  UnitStatsOverride,
} from '@iron-ridge/engine';
import {
  createGame,
  defaultSettings,
  validateGameState,
  validateFoundationCaptureCosts,
  validateRulesOverride,
} from '@iron-ridge/engine';
import { isEmptyRules, normalizeRules } from './draft.ts';

export const BALANCE_KEY = 'iron-ridge-balance-v1';

export type AppView = 'setup' | 'lab';

/** Setup's unsent form values, retained only when returning from the lab. */
export interface SetupSelection {
  settings: GameSettings;
  mode: 'ai' | 'hotseat' | 'spectate';
  campaignMode: 'classic' | 'simple' | 'advanced';
  additionalNodes: number;
  /** Advanced node placement can use a different seed from the generated terrain. */
  nodePlacementSeed?: number;
  commanderPrice: string;
  capturePrice: string;
  razePrice: string;
}

/** All playable lab launches use the same validated engine configuration as normal setup. */
export function newCampaignProblem(settings: GameSettings): string | null {
  if (
    !Number.isSafeInteger(settings.commanderTrainingCp) ||
    (settings.commanderTrainingCp ?? 0) <= 0
  )
    return 'Enter a positive whole commander training CP price in setup before starting a game.';
  try {
    if (settings.infrastructure) {
      const priceProblem = validateFoundationCaptureCosts(
        settings.infrastructure.nodes.captureCosts,
      );
      if (priceProblem) return priceProblem;
    }
    const errors = validateGameState(createGame(settings));
    return errors.length ? errors.join('; ') : null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'The selected campaign configuration is invalid';
  }
}

/** Lab is reachable in dev builds, or anywhere with `?lab` in the URL. */
export function labEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return new URLSearchParams(window.location.search).has('lab');
  } catch {
    return false;
  }
}

export function loadActiveRules(): RulesOverride | undefined {
  try {
    const raw = localStorage.getItem(BALANCE_KEY);
    if (!raw) return undefined;
    const v = validateRulesOverride(JSON.parse(raw));
    if (!v.ok || isEmptyRules(v.rules)) return undefined;
    return normalizeRules(v.rules);
  } catch {
    return undefined;
  }
}

function persist(rules: RulesOverride | undefined): void {
  try {
    if (rules) localStorage.setItem(BALANCE_KEY, JSON.stringify(rules));
    else localStorage.removeItem(BALANCE_KEY);
  } catch {
    // Storage unavailable (private mode, previews) — the override still applies this session.
  }
}

interface BalanceStore {
  view: AppView;
  /** Setup the lab was opened from — used by "Apply & new game". */
  setup: GameSettings;
  /** An invalid selected setup must never silently become a Classic launch. */
  setupError: string | null;
  setupSelection: SetupSelection | null;
  clearSetupSelection: () => void;
  /** Applied override (undefined = code baseline). */
  active: RulesOverride | undefined;
  /** Page draft (always normalized; `{}` = baseline). */
  draft: RulesOverride;
  /** Bumped whenever the draft is replaced wholesale, so cards re-seed their forms. */
  draftVersion: number;
  /** Cards with edits not yet saved into the draft (typeId or 'mechanics'). */
  dirtyCards: Record<string, true>;

  setCardDirty: (id: string, dirty: boolean) => void;
  openLab: (
    setup?: GameSettings | null,
    problem?: string | null,
    selection?: SetupSelection,
  ) => void;
  closeLab: () => void;
  /** Commit one unit's override into the draft. Returns validation errors (empty = ok). */
  saveUnit: (typeId: string, override: UnitStatsOverride | undefined) => string[];
  saveMechanics: (override: MechanicsOverride | undefined) => string[];
  /** Promote the draft to the active override and persist it. */
  applyAll: () => RulesOverride | undefined;
  /** Drop the active override (back to code baseline for new games). */
  clearActive: () => void;
  /** Replace the draft with the code baseline (`{}`). */
  resetDraft: () => void;
  /** Validate + load JSON text into the draft. Returns errors (empty = ok). */
  importJson: (text: string) => string[];
}

function validated(next: RulesOverride): { rules: RulesOverride; errors: string[] } {
  const v = validateRulesOverride(normalizeRules(next));
  return v.ok ? { rules: normalizeRules(v.rules), errors: [] } : { rules: next, errors: v.errors };
}

export const useBalanceStore = create<BalanceStore>((set, get) => {
  const active = loadActiveRules();
  return {
    view: 'setup',
    setup: defaultSettings(),
    setupError: newCampaignProblem(defaultSettings()),
    setupSelection: null,
    clearSetupSelection: () => set({ setupSelection: null }),
    active,
    draft: structuredClone(active ?? {}),
    draftVersion: 0,
    dirtyCards: {},

    setCardDirty: (id, dirty) =>
      set((s) => {
        if (dirty === (s.dirtyCards[id] === true)) return s;
        const next = { ...s.dirtyCards };
        if (dirty) next[id] = true;
        else delete next[id];
        return { dirtyCards: next };
      }),

    openLab: (setup, problem, selection) =>
      set((s) => ({
        view: 'lab',
        setup: structuredClone(setup ?? selection?.settings ?? s.setup),
        setupError:
          problem ??
          (setup
            ? newCampaignProblem(setup)
            : 'Complete the selected campaign configuration in setup before starting a game.'),
        setupSelection: selection ? structuredClone(selection) : null,
        // Start editing from what is applied now.
        draft: structuredClone(s.active ?? {}),
        draftVersion: s.draftVersion + 1,
        dirtyCards: {},
      })),

    closeLab: () => set({ view: 'setup', dirtyCards: {} }),

    saveUnit: (typeId, override) => {
      const units = { ...(get().draft.units ?? {}) };
      if (override) units[typeId] = override;
      else delete units[typeId];
      const { rules, errors } = validated({ ...get().draft, units });
      if (!errors.length) set({ draft: rules });
      return errors;
    },

    saveMechanics: (override) => {
      const next: RulesOverride = { ...get().draft };
      if (override) next.mechanics = override;
      else delete next.mechanics;
      const { rules, errors } = validated(next);
      if (!errors.length) set({ draft: rules });
      return errors;
    },

    applyAll: () => {
      const draft = normalizeRules(get().draft);
      const active = isEmptyRules(draft) ? undefined : structuredClone(draft);
      persist(active);
      set({ active });
      return active;
    },

    clearActive: () => {
      persist(undefined);
      set({ active: undefined });
    },

    resetDraft: () => set((s) => ({ draft: {}, draftVersion: s.draftVersion + 1, dirtyCards: {} })),

    importJson: (text) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        return [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`];
      }
      const v = validateRulesOverride(raw);
      if (!v.ok) return v.errors;
      set((s) => ({
        draft: normalizeRules(v.rules),
        draftVersion: s.draftVersion + 1,
        dirtyCards: {},
      }));
      return [];
    },
  };
});

/** Settings for a new game: the given setup with the active override attached. */
export function withActiveRules(settings: GameSettings): GameSettings {
  const { rules: _drop, ...rest } = settings;
  void _drop;
  const active = useBalanceStore.getState().active;
  return active ? { ...rest, rules: structuredClone(active) } : rest;
}
