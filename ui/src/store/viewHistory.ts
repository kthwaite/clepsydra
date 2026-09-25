import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CodexView } from "#/components/codex/useCodexView";
import { isCoreView, VIEW_REGISTRY } from "#/components/codex/viewRegistry";

const MAX_RECENT = 3;

function knownViews(value: unknown): CodexView[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (v): v is CodexView =>
        typeof v === "string" && Object.hasOwn(VIEW_REGISTRY, v),
    )
    .slice(0, MAX_RECENT);
}

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
      // Stored names may outlive their view (renamed or removed later);
      // an unknown one would crash Contents, so keep only registry views.
      merge: (persisted, current) => ({
        ...current,
        recent: knownViews((persisted as { recent?: unknown })?.recent),
      }),
    },
  ),
);
