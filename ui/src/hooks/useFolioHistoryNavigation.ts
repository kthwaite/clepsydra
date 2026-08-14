import type { HistoryState, RouterHistory } from "@tanstack/history";
import {
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback, useLayoutEffect } from "react";
import { routeViewFromMatches } from "#/components/codex/useCodexView";
import {
  captureFolioHistoryLocation,
  type FolioHistoryDestination,
  readFolioHistoryDestination,
  requestFolioHistoryRestoration,
} from "#/store/folioRestoration";
import {
  type OpenTabTarget,
  runWorkspaceTransition,
  type TabType,
  useWorkspaceStore,
} from "#/store/workspace";

declare module "@tanstack/history" {
  interface HistoryState {
    folioTabId?: string | null;
    folioPath?: string | null;
    folioLocationId?: string | null;
    folioOriginTabId?: string | null;
  }
}

export type OpenTabWithFolioHistory = (
  type: TabType,
  path?: string,
  label?: string,
  target?: OpenTabTarget,
) => void;

export type ActivateTabWithFolioHistory = (tabId: string) => void;

export type LeaveFolioWorkspace = (
  navigateAway: () => void,
  options?: {
    originTabId?: string | null;
    historyTraversal?: boolean;
  },
) => void;

let trackedHistoryDestination: FolioHistoryDestination | null = null;
let capturedDepartureLocationId: string | null = null;
type FolioHistoryTraversalGuard = (proceed: () => void) => boolean;
const folioHistoryTraversalGuards = new Set<FolioHistoryTraversalGuard>();
let trackedHistoryEntryIdentity: string | null = null;
let trackedHistoryOriginTabId: string | null = null;

function historyEntryIdentity(state: HistoryState): string {
  const parsed = state as HistoryState & {
    __TSR_key?: string;
    __TSR_index?: number;
    key?: string;
  };
  if (parsed.__TSR_key) return `key:${parsed.__TSR_key}`;
  if (parsed.key) return `key:${parsed.key}`;
  return `index:${parsed.__TSR_index ?? "unknown"}`;
}

function runFolioHistoryTraversalGuards(
  proceed: (approved: Set<FolioHistoryTraversalGuard>) => void,
  approved = new Set<FolioHistoryTraversalGuard>(),
): void {
  for (const guard of folioHistoryTraversalGuards) {
    if (approved.has(guard)) continue;
    const nextApproved = new Set(approved);
    nextApproved.add(guard);
    if (guard(() => runFolioHistoryTraversalGuards(proceed, nextApproved))) {
      return;
    }
  }
  proceed(approved);
}


export function registerFolioHistoryTraversalGuard(
  guard: FolioHistoryTraversalGuard,
): () => void {
  folioHistoryTraversalGuards.add(guard);
  return () => {
    folioHistoryTraversalGuards.delete(guard);
  };
}

function captureTrackedHistoryDestination(): void {
  const destination = trackedHistoryDestination;
  if (!destination) return;
  captureFolioHistoryLocation(
    destination.folioLocationId,
    destination.folioTabId,
    destination.folioPath,
  );
}

function activeDestinationState(
  folioOriginTabId: string | null,
): HistoryState {
  const workspace = useWorkspaceStore.getState();
  const active = workspace.tabs.find(
    (tab) => tab.id === workspace.activeTabId,
  );
  if (active?.type === "page" && active.path) {
    return {
      folioTabId: active.id,
      folioPath: active.path,
      folioLocationId: crypto.randomUUID(),
      folioOriginTabId,
    };
  }
  return {
    folioTabId: null,
    folioPath: null,
    folioLocationId: null,
    folioOriginTabId,
  };
}

/** Replace an archived Folio's current browser-history tuple with the single
 * survivor selected by the atomic workspace cleanup, or a launcher tuple. */
export function replaceFolioHistoryAfterArchive(
  history: RouterHistory,
): void {
  const nextState = activeDestinationState(null);
  capturedDepartureLocationId = null;
  trackedHistoryDestination = readFolioHistoryDestination(nextState);
  trackedHistoryOriginTabId = null;
  history.replace(
    history.location.href,
    { ...history.location.state, ...nextState },
    { ignoreBlocker: true },
  );
}


function applyHistoryDestination(
  destination: FolioHistoryDestination,
): void {
  const workspace = useWorkspaceStore.getState();
  const tab = workspace.tabs.find(
    (candidate) =>
      candidate.id === destination.folioTabId &&
      candidate.type === "page" &&
      candidate.path === destination.folioPath,
  );
  if (!tab) return;

  workspace.activateTabFromHistory(tab.id);
  requestFolioHistoryRestoration({
    tabId: tab.id,
    path: destination.folioPath,
    locationId: destination.folioLocationId,
  });
}



export function useFolioHistoryController(): void {
  const router = useRouter();

  useLayoutEffect(() => {
    const history = router.history;
    const initialDestination = readFolioHistoryDestination(
      history.location.state,
    );
    trackedHistoryDestination = initialDestination;
    trackedHistoryOriginTabId =
      history.location.state.folioOriginTabId ?? null;
    const back = history.back;
    const forward = history.forward;
    trackedHistoryEntryIdentity = historyEntryIdentity(history.location.state);
    const runGuardedBack = (
      options?: Parameters<typeof back>[0],
      approved = new Set<FolioHistoryTraversalGuard>(),
    ) => {
      if (options?.ignoreBlocker) {
        back(options);
        return;
      }
      runFolioHistoryTraversalGuards(() => back(options), approved);
    };
    const runGuardedForward = (
      options?: Parameters<typeof forward>[0],
      approved = new Set<FolioHistoryTraversalGuard>(),
    ) => {
      if (options?.ignoreBlocker) {
        forward(options);
        return;
      }
      runFolioHistoryTraversalGuards(() => forward(options), approved);
    };
    const guardedBack: typeof history.back = (options) => {
      runGuardedBack(options);
    };
    const guardedForward: typeof history.forward = (options) => {
      runGuardedForward(options);
    };
    history.back = guardedBack;
    history.forward = guardedForward;

    const unsubscribe = history.subscribe(({ action, location }) => {
      const destination = readFolioHistoryDestination(location.state);
      const incomingOriginTabId = location.state.folioOriginTabId ?? null;
      const entryIdentity = historyEntryIdentity(location.state);
      if (
        action.type !== "BACK" &&
        action.type !== "FORWARD" &&
        action.type !== "GO"
      ) {
        capturedDepartureLocationId = null;
        trackedHistoryEntryIdentity = entryIdentity;
        trackedHistoryDestination = destination;
        trackedHistoryOriginTabId = incomingOriginTabId;
        return;
      }
      if (entryIdentity === trackedHistoryEntryIdentity) return;

      const outgoing = trackedHistoryDestination;
      const outgoingOriginTabId = trackedHistoryOriginTabId;
      if (
        outgoing &&
        capturedDepartureLocationId !== outgoing.folioLocationId
      ) {
        captureFolioHistoryLocation(
          outgoing.folioLocationId,
          outgoing.folioTabId,
          outgoing.folioPath,
        );
      }
      capturedDepartureLocationId = null;
      trackedHistoryDestination = destination;
      trackedHistoryEntryIdentity = entryIdentity;
      trackedHistoryOriginTabId = incomingOriginTabId;
      if (destination) applyHistoryDestination(destination);
      if (!destination && action.type === "BACK" && outgoingOriginTabId) {
        const workspace = useWorkspaceStore.getState();
        if (workspace.tabs.some((tab) => tab.id === outgoingOriginTabId)) {
          workspace.activateTabFromHistory(outgoingOriginTabId);
        }
      }
    });

    if (initialDestination) {
      applyHistoryDestination(initialDestination);
    } else {
      const initialState = activeDestinationState(
        history.location.state.folioOriginTabId ?? null,
      );
      if (initialState.folioTabId) {
        history.replace(
          history.location.href,
          { ...history.location.state, ...initialState },
          { ignoreBlocker: true },
        );
      }
    }

    return () => {
      unsubscribe();
      if (history.back === guardedBack) history.back = back;
      if (history.forward === guardedForward) history.forward = forward;
      trackedHistoryDestination = null;
      trackedHistoryOriginTabId = null;
      trackedHistoryEntryIdentity = null;
      capturedDepartureLocationId = null;
    };
  }, [router]);
}

export function useOpenTabWithFolioHistory(): OpenTabWithFolioHistory {
  const navigate = useNavigate();
  const onWorkspaceRoute = useRouterState({
    select: (state) => routeViewFromMatches(state.matches) === "workspace",
  });

  return useCallback(
    (type, path, label, target) => {
      const workspace = useWorkspaceStore.getState();
      const requested = workspace.tabs.find((tab) =>
        type === "graph"
          ? tab.type === "graph"
          : tab.type === "page" && tab.path === path,
      );
      if (
        onWorkspaceRoute &&
        requested?.id === workspace.activeTabId &&
        !(type === "page" && target?.blockId)
      ) {
        return;
      }

      runWorkspaceTransition(() => {
        const current = useWorkspaceStore.getState();
        const folioOriginTabId = onWorkspaceRoute
          ? current.activeTabId
          : null;
        captureTrackedHistoryDestination();
        current.openTab(type, path, label, target);
        const destinationState = activeDestinationState(folioOriginTabId);
        void navigate({
          to: "/workspace",
          state: (state) => ({ ...state, ...destinationState }),
        });
      });
    },
    [navigate, onWorkspaceRoute],
  );
}

export function useActivateTabWithFolioHistory(): ActivateTabWithFolioHistory {
  const navigate = useNavigate();
  const onWorkspaceRoute = useRouterState({
    select: (state) => routeViewFromMatches(state.matches) === "workspace",
  });

  return useCallback(
    (tabId) => {
      const workspace = useWorkspaceStore.getState();
      if (
        (onWorkspaceRoute && workspace.activeTabId === tabId) ||
        !workspace.tabs.some((tab) => tab.id === tabId)
      ) {
        return;
      }

      runWorkspaceTransition(() => {
        const current = useWorkspaceStore.getState();
        if (
          (onWorkspaceRoute && current.activeTabId === tabId) ||
          !current.tabs.some((tab) => tab.id === tabId)
        ) {
          return;
        }
        const folioOriginTabId = onWorkspaceRoute ? current.activeTabId : null;
        captureTrackedHistoryDestination();
        current.activateTab(tabId);
        const destinationState = activeDestinationState(folioOriginTabId);
        void navigate({
          to: "/workspace",
          state: (state) => ({ ...state, ...destinationState }),
        });
      });
    },
    [navigate, onWorkspaceRoute],
  );
}

export function useLeaveFolioWorkspace(): LeaveFolioWorkspace {
  return useCallback((navigateAway, options) => {
    runWorkspaceTransition(() => {
      const outgoing = trackedHistoryDestination;
      captureTrackedHistoryDestination();
      capturedDepartureLocationId = outgoing?.folioLocationId ?? null;

      const originTabId = options?.originTabId;
      if (originTabId) {
        const workspace = useWorkspaceStore.getState();
        if (workspace.tabs.some((tab) => tab.id === originTabId)) {
          workspace.activateTabFromHistory(originTabId);
        }
      }
      navigateAway();
      capturedDepartureLocationId = null;
    });
  }, []);
}
