import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CodexView } from "#/components/codex/useCodexView";
import { isCoreView, VIEW_REGISTRY } from "#/components/codex/viewRegistry";

const MAX_RECENT = 3;

interface ViewHistoryState {
  recent: CodexView[];
  record: (view: CodexView) => void;
}

/** Recently visited Contents screens ("Recently: …" in the sheet). Core
 *  views live in the header, so they are not recorded. */
export const useViewHistory = create<ViewHistoryState>()(
  persist(
    (set) => ({
      recent: [],
      record: (view) => {
        const d = VIEW_REGISTRY[view];
        if (d.group === null || d.go === null || isCoreView(view)) return;
        set((s) => ({
          recent: [view, ...s.recent.filter((v) => v !== view)].slice(
            0,
            MAX_RECENT,
          ),
        }));
      },
    }),
    {
      name: "clepsydra.recentViews",
      partialize: (s) => ({ recent: s.recent }),
    },
  ),
);
