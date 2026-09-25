import { create } from 'zustand';

const KEY = 'iron-ridge-panels-v1';

interface PanelPrefs {
  collapsed: Record<string, boolean>;
  autoCollapse: boolean;
}

interface PanelStore extends PanelPrefs {
  setCollapsed: (patch: Record<string, boolean>) => void;
  setAutoCollapse: (on: boolean) => void;
}

function load(): PanelPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw)
      return { collapsed: {}, autoCollapse: true, ...(JSON.parse(raw) as Partial<PanelPrefs>) };
  } catch {
    // Per-viewer convenience only — fall back to defaults.
  }
  return { collapsed: {}, autoCollapse: true };
}

function persist(p: PanelPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Ignore unavailable storage.
  }
}

export const usePanelStore = create<PanelStore>((set, get) => ({
  ...load(),
  setCollapsed: (patch) => {
    const collapsed = { ...get().collapsed, ...patch };
    set({ collapsed });
    persist({ collapsed, autoCollapse: get().autoCollapse });
  },
  setAutoCollapse: (autoCollapse) => {
    set({ autoCollapse });
    persist({ collapsed: get().collapsed, autoCollapse });
  },
}));
