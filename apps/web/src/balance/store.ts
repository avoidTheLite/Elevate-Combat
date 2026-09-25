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
import { defaultSettings, validateRulesOverride } from '@iron-ridge/engine';
import { isEmptyRules, normalizeRules } from './draft.ts';

export const BALANCE_KEY = 'iron-ridge-balance-v1';

export type AppView = 'setup' | 'lab';

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
  /** Applied override (undefined = code baseline). */
  active: RulesOverride | undefined;
  /** Page draft (always normalized; `{}` = baseline). */
  draft: RulesOverride;
  /** Bumped whenever the draft is replaced wholesale, so cards re-seed their forms. */
  draftVersion: number;
  /** Cards with edits not yet saved into the draft (typeId or 'mechanics'). */
  dirtyCards: Record<string, true>;

  setCardDirty: (id: string, dirty: boolean) => void;
  openLab: (setup?: GameSettings) => void;
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

    openLab: (setup) =>
      set((s) => ({
        view: 'lab',
        setup: setup ?? s.setup,
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
