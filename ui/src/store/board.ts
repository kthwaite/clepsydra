import { create } from "zustand";
import { persist } from "zustand/middleware";

export type BoardMode = "card" | "backlog" | "cycle" | "timeline";

export const KANBAN_COL_MIN = 220;
export const KANBAN_COL_MAX = 640;
export const KANBAN_COL_DEFAULT = 282;
export const clampColumnWidth = (width: number): number =>
  Math.min(KANBAN_COL_MAX, Math.max(KANBAN_COL_MIN, Math.round(width)));

interface BoardState {
  // Persisted
  mode: BoardMode;
  /** Operation code | "ALL" | "UNFILED" */
  opFilter: string;
  /** Cycle code | "BACKLOG" | "" (resolved to active cycle at render) */
  cycleSel: string;
  railOpen: boolean;
  /** Kanban column id → persisted pixel width (unset = default basis) */
  columnWidths: Record<string, number>;
  // Ephemeral
  editTaskId: string | null;
  taskModal: { project?: string; status?: string; cycle?: string } | null;
  cycleModal:
    | { kind: "new" }
    | { kind: "open" | "seal"; cycleId: string }
    | null;
}

interface BoardActions {
  setMode: (mode: BoardMode) => void;
  setOpFilter: (filter: string) => void;
  setCycleSel: (cycle: string) => void;
  setRailOpen: (open: boolean) => void;
  setColumnWidth: (col: string, width: number) => void;
  resetColumnWidth: (col: string) => void;
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
}

export const useBoardStore = create<BoardState & BoardActions>()(
  persist(
    (set) => ({
      // Persisted defaults
      mode: "card",
      opFilter: "ALL",
      cycleSel: "",
      railOpen: true,
      columnWidths: {},
      // Ephemeral defaults
      editTaskId: null,
      taskModal: null,
      cycleModal: null,

      setMode: (mode) => set({ mode }),
      setOpFilter: (opFilter) => set({ opFilter }),
      setCycleSel: (cycleSel) => set({ cycleSel }),
      setRailOpen: (railOpen) => set({ railOpen }),
      setColumnWidth: (col, width) =>
        set((state) => ({
          columnWidths: {
            ...state.columnWidths,
            [col]: clampColumnWidth(width),
          },
        })),
      resetColumnWidth: (col) =>
        set((state) => {
          const { [col]: _removed, ...columnWidths } = state.columnWidths;
          return { columnWidths };
        }),
      setEditTaskId: (editTaskId) => set({ editTaskId }),
      openTaskModal: (opts = {}) => set({ taskModal: opts }),
      closeTaskModal: () => set({ taskModal: null }),
      openCycleModal: (modal) => set({ cycleModal: modal }),
      closeCycleModal: () => set({ cycleModal: null }),
    }),
    {
      name: "clepsydra.board",
      version: 1,
      partialize: (state) => ({
        mode: state.mode,
        opFilter: state.opFilter,
        cycleSel: state.cycleSel,
        railOpen: state.railOpen,
        columnWidths: state.columnWidths,
      }),
    },
  ),
);
