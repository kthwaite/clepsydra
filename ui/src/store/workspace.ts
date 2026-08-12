import { create } from "zustand";
import { persist } from "zustand/middleware";
import { clearFolioRestoration } from "#/store/folioRestoration";
import {
  nearestVisibleTabId,
  nextQuireColor,
  normalizeQuires,
  type Quire,
  type QuireColor,
} from "#/store/quires";

export type NavigationMode = "replace" | "new" | "smart";
export type TabType = "page" | "graph";
export interface OpenTabTarget {
  blockId?: string;
}

type WorkspaceTransitionGuard = (proceed: () => void) => boolean;

let workspaceTransitionGuard: WorkspaceTransitionGuard | null = null;
let workspaceTransitionDepth = 0;

export function registerWorkspaceTransitionGuard(
  guard: WorkspaceTransitionGuard,
): () => void {
  workspaceTransitionGuard = guard;
  return () => {
    if (workspaceTransitionGuard === guard) workspaceTransitionGuard = null;
  };
}

export function runWorkspaceTransition(transition: () => void): boolean {
  if (workspaceTransitionDepth > 0) {
    transition();
    return true;
  }

  const proceed = () => {
    workspaceTransitionDepth += 1;
    try {
      transition();
    } finally {
      workspaceTransitionDepth -= 1;
    }
  };
  if (workspaceTransitionGuard?.(proceed)) return false;
  proceed();
  return true;
}

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
  // Invariant pass over rehydrated state (dangling quireIds, gaps in runs,
  // quires persisted by older/buggy builds).
  return { ...s, ...normalizeQuires(s.tabs ?? [], s.quires ?? {}) };
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
  /** One-shot request to reveal a source block. Never persisted. */
  focusBlockId?: string;
  /** Identity used to claim a focus request at most once. Never persisted. */
  focusRequestId?: string;
}

interface WorkspaceState {
  tabs: TabDescriptor[];
  activeTabId: string | null;
  navigationMode: NavigationMode;
  openHistory: OpenHistoryEntry[];
  quires: Record<string, Quire>;
}

interface WorkspaceActions {
  openTab: (
    type: TabType,
    path?: string,
    label?: string,
    target?: OpenTabTarget,
  ) => void;
  addTab: (tab: TabDescriptor) => void;
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  /** Drop focus without closing any tab — surfaces the empty-state launcher. */
  clearActiveTab: () => void;
  clearTabFocus: (tabId: string) => void;
  takeTabFocus: (tabId: string, requestId: string) => string | undefined;
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

function withoutTabFocus(tab: TabDescriptor): TabDescriptor {
  if (
    tab.focusBlockId === undefined &&
    tab.focusRequestId === undefined
  ) {
    return tab;
  }
  const { focusBlockId: _, focusRequestId: __, ...rest } = tab;
  return rest;
}

/** Re-establish quire invariants after a mutation; merge any extra changes. */
function normalized(
  tabs: TabDescriptor[],
  quires: Record<string, Quire>,
  extra: Partial<WorkspaceState> = {},
): Partial<WorkspaceState> {
  // extra first: normalizeQuires' tabs/quires always win, so callers cannot
  // accidentally override the invariant-enforced structure via `extra`.
  return { ...extra, ...normalizeQuires(tabs, quires) };
}

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      navigationMode: "smart",
      openHistory: [],
      quires: {},

      openTab(type, path, label, target) {
        const state = get();
        const key = tabKey(type, path);

        // Check for existing tab with same content
        const existing = state.tabs.find((t) => tabKey(t.type, t.path) === key);
        if (
          workspaceTransitionDepth === 0 &&
          existing?.id !== state.activeTabId
        ) {
          runWorkspaceTransition(() =>
            get().openTab(type, path, label, target),
          );
          return;
        }

        if (existing) {
          // Always focus existing tab regardless of mode; an explicit open of
          // a hidden tab auto-expands its quire (active is never hidden).
          const quire = existing.quireId
            ? state.quires[existing.quireId]
            : undefined;
          set({
            activeTabId: existing.id,
            tabs: state.tabs.map((t) =>
              t.id === existing.id
                ? {
                    ...t,
                    lastActiveAt: Date.now(),
                    focusBlockId:
                      existing.type === "page" ? target?.blockId : undefined,
                    focusRequestId:
                      existing.type === "page" && target?.blockId
                        ? crypto.randomUUID()
                        : undefined,
                  }
                : withoutTabFocus(t),
            ),
            quires: quire?.collapsed
              ? { ...state.quires, [quire.id]: { ...quire, collapsed: false } }
              : state.quires,
            openHistory:
              existing.type === "page" && existing.path
                ? pushOpenHistory(state.openHistory, existing.path, Date.now())
                : state.openHistory,
          });
          return;
        }

        const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
        // New page tabs inherit the active page tab's quire (self-assembling
        // research context); graph tabs never join quires. Only the append
        // branch uses this — replace mode keeps the slot's own quire. Never
        // inherit a collapsed quire: the new tab becomes active and must
        // stay visible.
        const inheritedQuire = activeTab?.quireId
          ? state.quires[activeTab.quireId]
          : undefined;
        const inheritedQuireId =
          type === "page" &&
          activeTab?.type === "page" &&
          !inheritedQuire?.collapsed
            ? activeTab.quireId
            : undefined;
        const newTab: TabDescriptor = {
          id: crypto.randomUUID(),
          type,
          path: type === "page" ? path : undefined,
          label: label ?? path ?? "Graph",
          lastActiveAt: Date.now(),
          focusBlockId: type === "page" ? target?.blockId : undefined,
          focusRequestId:
            type === "page" && target?.blockId
              ? crypto.randomUUID()
              : undefined,
        };

        const nextHistory =
          type === "page" && path
            ? pushOpenHistory(state.openHistory, path, Date.now())
            : state.openHistory;

        if (state.navigationMode === "replace" && state.activeTabId) {
          if (
            activeTab &&
            (activeTab.type !== type || activeTab.path !== path)
          ) {
            clearFolioRestoration(activeTab.id);
          }
          // Replace the active tab's content; the slot keeps its quire.
          set(
            normalized(
              state.tabs.map((t) =>
                t.id === state.activeTabId
                  ? { ...newTab, id: t.id, quireId: t.quireId }
                  : withoutTabFocus(t),
              ),
              state.quires,
              { openHistory: nextHistory },
            ),
          );
        } else {
          // "new" or "smart" — append; normalize gathers it to its quire run.
          set(
            normalized(
              [
                ...state.tabs.map(withoutTabFocus),
                { ...newTab, quireId: inheritedQuireId },
              ],
              state.quires,
              { activeTabId: newTab.id, openHistory: nextHistory },
            ),
          );
        }
      },

      addTab(tab) {
        if (
          workspaceTransitionDepth === 0 &&
          tab.id !== get().activeTabId
        ) {
          runWorkspaceTransition(() => get().addTab(tab));
          return;
        }
        // Caller contract: do not pass a quireId belonging to a collapsed
        // quire — addTab activates the tab and would break the
        // active-tab-is-never-hidden invariant.
        set((state) =>
          normalized([...state.tabs.map(withoutTabFocus), tab], state.quires, {
            activeTabId: tab.id,
          }),
        );
      },

      closeTab(tabId) {
        const state = get();
        const idx = state.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        if (
          workspaceTransitionDepth === 0 &&
          state.activeTabId === tabId
        ) {
          runWorkspaceTransition(() => get().closeTab(tabId));
          return;
        }

        clearFolioRestoration(tabId);

        const nextTabs = state.tabs.filter((t) => t.id !== tabId);
        let nextActive = state.activeTabId;

        if (state.activeTabId === tabId) {
          nextActive =
            nextTabs.length === 0
              ? null
              : nearestVisibleTabId(
                  nextTabs,
                  state.quires,
                  Math.min(idx, nextTabs.length - 1),
                );
        }

        set(
          normalized(nextTabs, state.quires, {
            activeTabId: nextActive,
          }),
        );
      },

      closeOtherTabs(tabId) {
        if (
          workspaceTransitionDepth === 0 &&
          get().activeTabId !== tabId
        ) {
          runWorkspaceTransition(() => get().closeOtherTabs(tabId));
          return;
        }
        set((state) =>
          normalized(
            state.tabs
              .filter((t) => t.id === tabId || t.pinned)
              .map((t) => (t.id === tabId ? t : withoutTabFocus(t))),
            state.quires,
            { activeTabId: tabId },
          ),
        );
      },

      activateTab(tabId) {
        if (
          workspaceTransitionDepth === 0 &&
          get().activeTabId !== tabId
        ) {
          runWorkspaceTransition(() => get().activateTab(tabId));
          return;
        }
        set((state) => {
          const tab = state.tabs.find((t) => t.id === tabId);
          // Activation must never land on a hidden tab — expand its quire.
          const quire = tab?.quireId ? state.quires[tab.quireId] : undefined;
          return {
            activeTabId: tabId,
            tabs: state.tabs.map((t) =>
              t.id === tabId
                ? { ...t, lastActiveAt: Date.now() }
                : withoutTabFocus(t),
            ),
            quires: quire?.collapsed
              ? { ...state.quires, [quire.id]: { ...quire, collapsed: false } }
              : state.quires,
            openHistory:
              tab?.type === "page" && tab.path
                ? pushOpenHistory(state.openHistory, tab.path, Date.now())
                : state.openHistory,
          };
        });
      },

      clearActiveTab() {
        if (
          workspaceTransitionDepth === 0 &&
          get().activeTabId !== null
        ) {
          runWorkspaceTransition(() => get().clearActiveTab());
          return;
        }
        set((state) => ({
          activeTabId: null,
          tabs: state.tabs.map(withoutTabFocus),
        }));
      },

      clearTabFocus(tabId) {
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === tabId ? withoutTabFocus(tab) : tab,
          ),
        }));
      },

      takeTabFocus(tabId, requestId) {
        const state = get();
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        if (
          tab?.focusRequestId !== requestId ||
          tab.focusBlockId === undefined
        ) {
          return undefined;
        }
        set({
          tabs: state.tabs.map((candidate) =>
            candidate.id === tabId ? withoutTabFocus(candidate) : candidate,
          ),
        });
        return tab.focusBlockId;
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
          return normalized(tabs, state.quires);
        });
      },

      updateTabLabel(tabId, label) {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, label } : t)),
        }));
      },

      updateTabPath(tabId, path, label) {
        const currentTab = get().tabs.find((tab) => tab.id === tabId);
        if (
          workspaceTransitionDepth === 0 &&
          currentTab?.id === get().activeTabId &&
          currentTab.path !== path
        ) {
          runWorkspaceTransition(() => get().updateTabPath(tabId, path, label));
          return;
        }
        if (currentTab && currentTab.path !== path) {
          clearFolioRestoration(tabId);
        }
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
          if (tab.quireId === quireId) return state; // already a member; no-op
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
        const current = get();
        const active = current.tabs.find(
          (tab) => tab.id === current.activeTabId,
        );
        if (
          workspaceTransitionDepth === 0 &&
          current.quires[quireId]?.collapsed === false &&
          active?.quireId === quireId
        ) {
          runWorkspaceTransition(() => get().toggleQuireCollapse(quireId));
          return;
        }
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
        const current = get();
        const active = current.tabs.find(
          (tab) => tab.id === current.activeTabId,
        );
        if (
          workspaceTransitionDepth === 0 &&
          active?.quireId === quireId &&
          !active.pinned
        ) {
          runWorkspaceTransition(() => get().closeQuireTabs(quireId));
          return;
        }
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
            // Old quires map on purpose: if the quire was collapsed and a pinned
            // member survives, it stays collapsed (and hidden) — the label chip
            // still renders, so the survivor remains discoverable.
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
      partialize: (state) => ({
        ...state,
        tabs: state.tabs.map(withoutTabFocus),
      }),
    },
  ),
);
