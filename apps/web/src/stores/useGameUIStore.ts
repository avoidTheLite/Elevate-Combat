import { create } from 'zustand';

interface GameUIState {
  selectedUnitId: string | null;
  selectUnit: (id: string | null) => void;
}

export const useGameUIStore = create<GameUIState>((set) => ({
  selectedUnitId: null,
  selectUnit: (id) => set({ selectedUnitId: id }),
}));
