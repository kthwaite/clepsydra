import type { HistoryState } from "@tanstack/history";
import {
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
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
  options?: { originTabId?: string | null },
) => void;

let trackedHistoryDestination: FolioHistoryDestination | null = null;
let capturedDepartureLocationId: string | null = null;

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

  useEffect(() => {
    const history = router.history;
    const initialDestination = readFolioHistoryDestination(
      history.location.state,
    );
    trackedHistoryDestination = initialDestination;

    const unsubscribe = history.subscribe(({ action, location }) => {
      const destination = readFolioHistoryDestination(location.state);
      if (
        action.type !== "BACK" &&
        action.type !== "FORWARD" &&
        action.type !== "GO"
      ) {
        capturedDepartureLocationId = null;
        trackedHistoryDestination = destination;
        return;
      }

      const outgoing = trackedHistoryDestination;
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
      if (destination) applyHistoryDestination(destination);
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
      trackedHistoryDestination = null;
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

  return useCallback(
    (tabId) => {
      const workspace = useWorkspaceStore.getState();
      if (
        workspace.activeTabId === tabId ||
        !workspace.tabs.some((tab) => tab.id === tabId)
      ) {
        return;
      }

      runWorkspaceTransition(() => {
        const current = useWorkspaceStore.getState();
        if (
          current.activeTabId === tabId ||
          !current.tabs.some((tab) => tab.id === tabId)
        ) {
          return;
        }
        const folioOriginTabId = current.activeTabId;
        captureTrackedHistoryDestination();
        current.activateTab(tabId);
        const destinationState = activeDestinationState(folioOriginTabId);
        void navigate({
          to: "/workspace",
          state: (state) => ({ ...state, ...destinationState }),
        });
      });
    },
    [navigate],
  );
}

export function useLeaveFolioWorkspace(): LeaveFolioWorkspace {
  return useCallback((navigateAway, options) => {
    runWorkspaceTransition(() => {
      const outgoing = trackedHistoryDestination;
      captureTrackedHistoryDestination();
      capturedDepartureLocationId = options
        ? (outgoing?.folioLocationId ?? null)
        : null;

      const originTabId = options?.originTabId;
      if (originTabId) {
        const workspace = useWorkspaceStore.getState();
        if (workspace.tabs.some((tab) => tab.id === originTabId)) {
          workspace.activateTabFromHistory(originTabId);
        }
      }
      navigateAway();
    });
  }, []);
}
