import { create } from "zustand";

interface FolioDockState {
  /** A docked panel (the base embed inspector) holds the Folio's right
   *  column, so the Page links rail steps aside rather than being covered. */
  rightDock: boolean;
  setRightDock: (rightDock: boolean) => void;
}

export const useFolioDock = create<FolioDockState>((set) => ({
  rightDock: false,
  setRightDock: (rightDock) => set({ rightDock }),
}));
