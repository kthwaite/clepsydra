import { create } from "zustand";
import type { Kind } from "#/lib/kind";

export type ConstellationDepth = 1 | 2 | null;
export type ConstellationViewMode = "graph" | "list";
export type ConstellationGrouping = "none" | "kind" | "folder";

interface ConstellationState {
  selectedAnchorId: string | null;
  selectedNodeId: string | null;
  depth: ConstellationDepth;
  focusHops: 1 | 2;
  hiddenKinds: Kind[];
  propertyRefsVisible: boolean;
  orphansVisible: boolean;
  mode: ConstellationViewMode;
  groupBy: ConstellationGrouping;
  setSelectedAnchorId: (anchorId: string | null) => void;
  setSelectedNodeId: (nodeId: string | null) => void;
  setDepth: (depth: ConstellationDepth) => void;
  setFocusHops: (hops: 1 | 2) => void;
  setKindVisible: (kind: Kind, visible: boolean) => void;
  setPropertyRefsVisible: (visible: boolean) => void;
  setOrphansVisible: (visible: boolean) => void;
  setMode: (mode: ConstellationViewMode) => void;
  setGroupBy: (groupBy: ConstellationGrouping) => void;
}

export const useConstellationStore = create<ConstellationState>((set) => ({
  selectedAnchorId: null,
  selectedNodeId: null,
  depth: null,
  focusHops: 1,
  hiddenKinds: [],
  propertyRefsVisible: true,
  orphansVisible: true,
  mode: "graph",
  groupBy: "none",
  setSelectedAnchorId: (selectedAnchorId) => set({ selectedAnchorId }),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setDepth: (depth) => set({ depth }),
  setFocusHops: (focusHops) => set({ focusHops }),
  setKindVisible: (kind, visible) =>
    set((state) => ({
      hiddenKinds: visible
        ? state.hiddenKinds.filter((value) => value !== kind)
        : state.hiddenKinds.includes(kind)
          ? state.hiddenKinds
          : [...state.hiddenKinds, kind],
    })),
  setPropertyRefsVisible: (propertyRefsVisible) => set({ propertyRefsVisible }),
  setOrphansVisible: (orphansVisible) => set({ orphansVisible }),
  setMode: (mode) => set({ mode }),
  setGroupBy: (groupBy) => set({ groupBy }),
}));
