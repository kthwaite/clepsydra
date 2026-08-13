import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";
import { routeViewFromMatches } from "#/components/codex/useCodexView";
import type { OpenTabTarget, TabType } from "#/store/workspace";
import { runWorkspaceTransition, useWorkspaceStore } from "#/store/workspace";

declare module "@tanstack/history" {
  interface HistoryState {
    folioOriginTabId?: string | null;
  }
}

export function useOpenTab() {
  const openTab = useWorkspaceStore((s) => s.openTab);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const onWorkspaceRoute = useRouterState({
    select: (s) => routeViewFromMatches(s.matches) === "workspace",
  });
  const navigate = useNavigate();

  return useCallback(
    (type: TabType, path?: string, label?: string, target?: OpenTabTarget) => {
      const folioOriginTabId = onWorkspaceRoute ? activeTabId : null;
      runWorkspaceTransition(() => {
        openTab(type, path, label, target);
        void navigate({
          to: "/workspace",
          state: (state) => ({ ...state, folioOriginTabId }),
        });
      });
    },
    [activeTabId, navigate, onWorkspaceRoute, openTab],
  );
}
