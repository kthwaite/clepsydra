import { create } from "zustand";

export type ConstellationDepth = 1 | 2 | null;
export type ConstellationViewMode = "graph" | "list";

interface ConstellationState {
  selectedAnchorId: string | null;
  depth: ConstellationDepth;
  hideDaily: boolean;
  hideTasks: boolean;
  orphansVisible: boolean;
  mode: ConstellationViewMode;
  setSelectedAnchorId: (anchorId: string | null) => void;
  setDepth: (depth: ConstellationDepth) => void;
  setHideDaily: (hidden: boolean) => void;
  setHideTasks: (hidden: boolean) => void;
  setOrphansVisible: (visible: boolean) => void;
  setMode: (mode: ConstellationViewMode) => void;
}

export const useConstellationStore = create<ConstellationState>((set) => ({
  selectedAnchorId: null,
  depth: null,
  hideDaily: false,
  hideTasks: false,
  orphansVisible: true,
  mode: "graph",
  setSelectedAnchorId: (selectedAnchorId) => set({ selectedAnchorId }),
  setDepth: (depth) => set({ depth }),
  setHideDaily: (hideDaily) => set({ hideDaily }),
  setHideTasks: (hideTasks) => set({ hideTasks }),
  setOrphansVisible: (orphansVisible) => set({ orphansVisible }),
  setMode: (mode) => set({ mode }),
}));
