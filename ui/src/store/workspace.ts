import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  nearestVisibleTabId,
  nextQuireColor,
  normalizeQuires,
  type Quire,
  type QuireColor,
} from "#/store/quires";

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

/** Persist migrations: v1→v2 adds openHistory, v2→v3 adds quires. */
export function migrateWorkspace(
  persisted: unknown,
  version: number,
): Partial<WorkspaceState> {
  let s = (persisted ?? {}) as Partial<WorkspaceState>;
  if (version < 2 || !Array.isArray(s.openHistory)) {
    s = { ...s, openHistory: [] };
  }
  if (version < 3 || typeof s.quires !== "object" || s.quires === null) {
    s = { ...s, quires: {} };
  }
  return s;
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
  /** Membership in a quire (tab group). Members are kept contiguous. */
  quireId?: string;
}

interface WorkspaceState {
  tabs: TabDescriptor[];
  activeTabId: string | null;
  navigationMode: NavigationMode;
  openHistory: OpenHistoryEntry[];
  quires: Record<string, Quire>;
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
  updateTabPath: (tabId: string, path: string, label?: string) => void;
  setNavigationMode: (mode: NavigationMode) => void;
  createQuire: (tabId: string, name: string) => void;
  addTabToQuire: (tabId: string, quireId: string) => void;
  removeTabFromQuire: (tabId: string) => void;
  renameQuire: (quireId: string, name: string) => void;
  recolorQuire: (quireId: string, color: QuireColor) => void;
  toggleQuireCollapse: (quireId: string) => void;
  closeQuireTabs: (quireId: string) => void;
  ungroupQuire: (quireId: string) => void;
}

function tabKey(type: TabType, path?: string): string {
  return type === "graph" ? "graph" : `page:${path}`;
}

/** Re-establish quire invariants after a mutation; merge any extra changes. */
function normalized(
  tabs: TabDescriptor[],
  quires: Record<string, Quire>,
  extra: Partial<WorkspaceState> = {},
): Partial<WorkspaceState> {
  return { ...normalizeQuires(tabs, quires), ...extra };
}

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      navigationMode: "smart",
      openHistory: [],
      quires: {},

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

      updateTabPath(tabId, path, label) {
        set((state) => {
          const tab = state.tabs.find((t) => t.id === tabId);
          const oldPath = tab?.path;
          const nextHistory =
            tab?.type === "page" && oldPath && oldPath !== path
              ? pushOpenHistory(
                  state.openHistory.filter((e) => e.path !== oldPath),
                  path,
                  Date.now(),
                )
              : state.openHistory;
          return {
            tabs: state.tabs.map((t) =>
              t.id === tabId
                ? { ...t, path, ...(label !== undefined ? { label } : {}) }
                : t,
            ),
            openHistory: nextHistory,
          };
        });
      },

      setNavigationMode(mode) {
        set({ navigationMode: mode });
      },

      createQuire(tabId, name) {
        set((state) => {
          const tab = state.tabs.find((t) => t.id === tabId);
          if (!tab || tab.type !== "page") return state;
          const quire: Quire = {
            id: crypto.randomUUID(),
            name: name.trim() || "QUIRE",
            color: nextQuireColor(state.quires),
            collapsed: false,
          };
          return normalized(
            state.tabs.map((t) =>
              t.id === tabId ? { ...t, quireId: quire.id } : t,
            ),
            { ...state.quires, [quire.id]: quire },
          );
        });
      },

      addTabToQuire(tabId, quireId) {
        set((state) => {
          const quire = state.quires[quireId];
          const tab = state.tabs.find((t) => t.id === tabId);
          if (!quire || !tab || tab.type !== "page") return state;
          // Invariant: the active tab is never hidden — expand on demand.
          const expand = quire.collapsed && tabId === state.activeTabId;
          // Move the tab to after the last existing member of the quire so
          // normalizeQuires places it at the end of the run, not the middle.
          const withoutTab = state.tabs.filter((t) => t.id !== tabId);
          const lastMemberIdx = withoutTab.reduce(
            (acc, t, i) => (t.quireId === quireId ? i : acc),
            -1,
          );
          const insertAt =
            lastMemberIdx === -1 ? withoutTab.length : lastMemberIdx + 1;
          const reordered = [
            ...withoutTab.slice(0, insertAt),
            { ...tab, quireId },
            ...withoutTab.slice(insertAt),
          ];
          return normalized(
            reordered,
            expand
              ? { ...state.quires, [quireId]: { ...quire, collapsed: false } }
              : state.quires,
          );
        });
      },

      removeTabFromQuire(tabId) {
        set((state) =>
          normalized(
            state.tabs.map((t) =>
              t.id === tabId ? { ...t, quireId: undefined } : t,
            ),
            state.quires,
          ),
        );
      },

      renameQuire(quireId, name) {
        set((state) => {
          const quire = state.quires[quireId];
          if (!quire) return state;
          return {
            quires: {
              ...state.quires,
              [quireId]: { ...quire, name: name.trim() || quire.name },
            },
          };
        });
      },

      recolorQuire(quireId, color) {
        set((state) => {
          const quire = state.quires[quireId];
          if (!quire) return state;
          return {
            quires: { ...state.quires, [quireId]: { ...quire, color } },
          };
        });
      },

      toggleQuireCollapse(quireId) {
        set((state) => {
          const quire = state.quires[quireId];
          if (!quire) return state;
          const quires = {
            ...state.quires,
            [quireId]: { ...quire, collapsed: !quire.collapsed },
          };
          let activeTabId = state.activeTabId;
          if (!quire.collapsed) {
            // Collapsing: if the active tab just went hidden, re-home activation.
            const active = state.tabs.find((t) => t.id === state.activeTabId);
            if (active?.quireId === quireId) {
              const idx = state.tabs.findIndex((t) => t.id === active.id);
              activeTabId = nearestVisibleTabId(state.tabs, quires, idx);
            }
          }
          return { quires, activeTabId };
        });
      },

      closeQuireTabs(quireId) {
        set((state) => {
          const firstIdx = state.tabs.findIndex((t) => t.quireId === quireId);
          const nextTabs = state.tabs.filter(
            (t) => t.quireId !== quireId || t.pinned,
          );
          let activeTabId = state.activeTabId;
          if (activeTabId && !nextTabs.some((t) => t.id === activeTabId)) {
            const at = Math.min(
              Math.max(firstIdx, 0),
              Math.max(nextTabs.length - 1, 0),
            );
            activeTabId = nearestVisibleTabId(nextTabs, state.quires, at);
          }
          return normalized(nextTabs, state.quires, { activeTabId });
        });
      },

      ungroupQuire(quireId) {
        set((state) => {
          const { [quireId]: _, ...rest } = state.quires;
          return normalized(
            state.tabs.map((t) =>
              t.quireId === quireId ? { ...t, quireId: undefined } : t,
            ),
            rest,
          );
        });
      },
    }),
    {
      name: "clepsydra.workspace",
      version: 3,
      migrate: (persisted, version): Partial<WorkspaceState> =>
        migrateWorkspace(persisted, version),
    },
  ),
);
