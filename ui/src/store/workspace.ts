import { create } from "zustand";
import { persist } from "zustand/middleware";

export type NavigationMode = "replace" | "new" | "smart";
export type TabType = "page" | "graph";

export interface OpenHistoryEntry {
  path: string;
  openedAt: number;
}

const OPEN_HISTORY_CAP = 32;

/** Prepend `path`, de-duplicate by path (newest wins), cap to 32 entries. */
export function pushOpenHistory(
  history: OpenHistoryEntry[],
  path: string,
  now: number,
): OpenHistoryEntry[] {
  const without = history.filter((e) => e.path !== path);
  return [{ path, openedAt: now }, ...without].slice(0, OPEN_HISTORY_CAP);
}

export interface TabDescriptor {
  id: string;
  type: TabType;
  path?: string;
  label: string;
  /** Pinned tabs sort first in SHEAF and are visually marked. */
  pinned?: boolean;
  /** Epoch ms of last activation — orders the RECENT accordion section. */
  lastActiveAt?: number;
}

interface WorkspaceState {
  tabs: TabDescriptor[];
  activeTabId: string | null;
  navigationMode: NavigationMode;
  openHistory: OpenHistoryEntry[];
}

interface WorkspaceActions {
  openTab: (type: TabType, path?: string, label?: string) => void;
  addTab: (tab: TabDescriptor) => void;
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  togglePin: (tabId: string) => void;
  moveTab: (fromIndex: number, toIndex: number) => void;
  updateTabLabel: (tabId: string, label: string) => void;
  setNavigationMode: (mode: NavigationMode) => void;
}

function tabKey(type: TabType, path?: string): string {
  return type === "graph" ? "graph" : `page:${path}`;
}

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      navigationMode: "smart",
      openHistory: [],

      openTab(type, path, label) {
        const state = get();
        const key = tabKey(type, path);

        // Check for existing tab with same content
        const existing = state.tabs.find((t) => tabKey(t.type, t.path) === key);

        if (existing) {
          // Always focus existing tab regardless of mode
          set({
            activeTabId: existing.id,
            tabs: state.tabs.map((t) =>
              t.id === existing.id ? { ...t, lastActiveAt: Date.now() } : t,
            ),
            openHistory:
              existing.type === "page" && existing.path
                ? pushOpenHistory(state.openHistory, existing.path, Date.now())
                : state.openHistory,
          });
          return;
        }

        const newTab: TabDescriptor = {
          id: crypto.randomUUID(),
          type,
          path: type === "page" ? path : undefined,
          label: label ?? path ?? "Graph",
          lastActiveAt: Date.now(),
        };

        if (state.navigationMode === "replace" && state.activeTabId) {
          // Replace the active tab's content
          set({
            tabs: state.tabs.map((t) =>
              t.id === state.activeTabId ? { ...newTab, id: t.id } : t,
            ),
            openHistory:
              type === "page" && path
                ? pushOpenHistory(state.openHistory, path, Date.now())
                : state.openHistory,
          });
        } else {
          // "new" or "smart" — add new tab
          set({
            tabs: [...state.tabs, newTab],
            activeTabId: newTab.id,
            openHistory:
              type === "page" && path
                ? pushOpenHistory(state.openHistory, path, Date.now())
                : state.openHistory,
          });
        }
      },

      addTab(tab) {
        set((state) => ({
          tabs: [...state.tabs, tab],
          activeTabId: tab.id,
        }));
      },

      closeTab(tabId) {
        const state = get();
        const idx = state.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;

        const nextTabs = state.tabs.filter((t) => t.id !== tabId);
        let nextActive = state.activeTabId;

        if (state.activeTabId === tabId) {
          if (nextTabs.length === 0) {
            nextActive = null;
          } else if (idx < nextTabs.length) {
            // activate right neighbor
            nextActive = nextTabs[idx].id;
          } else {
            // was rightmost, activate new rightmost
            nextActive = nextTabs[nextTabs.length - 1].id;
          }
        }

        set({ tabs: nextTabs, activeTabId: nextActive });
      },

      closeOtherTabs(tabId) {
        set((state) => ({
          tabs: state.tabs.filter((t) => t.id === tabId),
          activeTabId: tabId,
        }));
      },

      activateTab(tabId) {
        set((state) => {
          const tab = state.tabs.find((t) => t.id === tabId);
          return {
            activeTabId: tabId,
            tabs: state.tabs.map((t) =>
              t.id === tabId ? { ...t, lastActiveAt: Date.now() } : t,
            ),
            openHistory:
              tab?.type === "page" && tab.path
                ? pushOpenHistory(state.openHistory, tab.path, Date.now())
                : state.openHistory,
          };
        });
      },

      togglePin(tabId) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, pinned: !t.pinned } : t,
          ),
        }));
      },

      moveTab(fromIndex, toIndex) {
        set((state) => {
          const tabs = [...state.tabs];
          const [moved] = tabs.splice(fromIndex, 1);
          tabs.splice(toIndex, 0, moved);
          return { tabs };
        });
      },

      updateTabLabel(tabId, label) {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, label } : t)),
        }));
      },

      setNavigationMode(mode) {
        set({ navigationMode: mode });
      },
    }),
    {
      name: "clepsydra.workspace",
      version: 2,
      migrate: (persisted, version): Partial<WorkspaceState> => {
        const s = (persisted ?? {}) as Partial<WorkspaceState>;
        if (version < 2 || !Array.isArray(s.openHistory)) {
          return { ...s, openHistory: [] };
        }
        return s;
      },
    },
  ),
);
