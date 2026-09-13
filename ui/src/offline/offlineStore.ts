import { create } from "zustand";
import { persist } from "zustand/middleware";

interface OfflineState {
  phase: "idle" | "running";
  progress: { done: number; total: number };
  /** ISO timestamp of the last completed full pass, or null if never. */
  lastFullSync: string | null;
  pageCount: number;
  lastError: string | null;
}

interface OfflineActions {
  start: (total: number) => void;
  advance: () => void;
  finishFull: (input: {
    at: string;
    pageCount: number;
    error: string | null;
  }) => void;
  finishDelta: (input: { error: string | null }) => void;
}

export const useOfflineStore = create<OfflineState & OfflineActions>()(
  persist(
    (set) => ({
      phase: "idle",
      progress: { done: 0, total: 0 },
      lastFullSync: null,
      pageCount: 0,
      lastError: null,

      start: (total) =>
        set({
          phase: "running",
          progress: { done: 0, total },
          lastError: null,
        }),
      advance: () =>
        set((s) => ({
          progress: { done: s.progress.done + 1, total: s.progress.total },
        })),
      finishFull: ({ at, pageCount, error }) =>
        set({ phase: "idle", lastFullSync: at, pageCount, lastError: error }),
      finishDelta: ({ error }) => set({ phase: "idle", lastError: error }),
    }),
    {
      name: "clepsydra-offline",
      partialize: (s) => ({
        lastFullSync: s.lastFullSync,
        pageCount: s.pageCount,
      }),
    },
  ),
);
