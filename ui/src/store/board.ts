import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  EMPTY_FILTER,
  type BoardFilter,
} from "#/components/tasking/board-filter";

export type BoardMode = "card" | "backlog" | "cycle" | "timeline";

interface BoardState {
  // Persisted
  mode: BoardMode;
  /** Operation code | "ALL" | "UNFILED" */
  opFilter: string;
  /** Cycle code | "BACKLOG" | "" (resolved to active cycle at render) */
  cycleSel: string;
  railOpen: boolean;
  // Ephemeral
  editTaskId: string | null;
  taskModal: { project?: string; status?: string; cycle?: string } | null;
  cycleModal:
    | { kind: "new" }
    | { kind: "open" | "seal"; cycleId: string }
    | null;
  filter: BoardFilter;
}

interface BoardActions {
  setMode: (mode: BoardMode) => void;
  setOpFilter: (filter: string) => void;
  setCycleSel: (cycle: string) => void;
  setRailOpen: (open: boolean) => void;
  setEditTaskId: (id: string | null) => void;
  openTaskModal: (opts?: {
    project?: string;
    status?: string;
    cycle?: string;
  }) => void;
  closeTaskModal: () => void;
  openCycleModal: (
    modal: { kind: "new" } | { kind: "open" | "seal"; cycleId: string },
  ) => void;
  closeCycleModal: () => void;
  setFilter: (filter: BoardFilter) => void;
}

export const useBoardStore = create<BoardState & BoardActions>()(
  persist(
    (set) => ({
      // Persisted defaults
      mode: "card",
      opFilter: "ALL",
      cycleSel: "",
      railOpen: true,
      // Ephemeral defaults
      editTaskId: null,
      taskModal: null,
      cycleModal: null,
      filter: EMPTY_FILTER,

      setMode: (mode) => set({ mode }),
      setOpFilter: (opFilter) => set({ opFilter }),
      setCycleSel: (cycleSel) => set({ cycleSel }),
      setRailOpen: (railOpen) => set({ railOpen }),
      setEditTaskId: (editTaskId) => set({ editTaskId }),
      openTaskModal: (opts = {}) => set({ taskModal: opts }),
      closeTaskModal: () => set({ taskModal: null }),
      openCycleModal: (modal) => set({ cycleModal: modal }),
      closeCycleModal: () => set({ cycleModal: null }),
      setFilter: (filter) => set({ filter }),
    }),
    {
      name: "clepsydra.board",
      version: 1,
      partialize: (state) => ({
        mode: state.mode,
        opFilter: state.opFilter,
        cycleSel: state.cycleSel,
        railOpen: state.railOpen,
      }),
    },
  ),
);
