import { create } from 'zustand';
import type { OverlayMode } from '../render/overlays.ts';
import { isOverlayMode } from '../render/overlays.ts';

const KEY = 'iron-ridge-view-v1';

interface ViewStore {
  overlay: OverlayMode;
  setOverlay: (mode: OverlayMode) => void;
}

function load(): OverlayMode {
  try {
    const v = localStorage.getItem(KEY);
    if (isOverlayMode(v)) return v;
  } catch {
    // Per-viewer convenience only.
  }
  return 'basic';
}

export const useViewStore = create<ViewStore>((set) => ({
  overlay: load(),
  setOverlay: (overlay) => {
    set({ overlay });
    try {
      localStorage.setItem(KEY, overlay);
    } catch {
      // Ignore unavailable storage.
    }
  },
}));
