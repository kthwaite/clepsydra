import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import {
  runWorkspaceTransition,
  type TabType,
  useWorkspaceStore,
} from "#/store/workspace";

declare module "@tanstack/history" {
  interface HistoryState {
    folioOriginTabId?: string | null;
  }
}

export function useOpenTab() {
  const openTab = useWorkspaceStore((s) => s.openTab);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const { pathname } = useLocation();
  const navigate = useNavigate();

  return useCallback(
    (type: TabType, path?: string, label?: string) => {
      const folioOriginTabId =
        pathname === "/workspace" ? activeTabId : null;
      runWorkspaceTransition(() => {
        openTab(type, path, label);
        void navigate({
          to: "/workspace",
          state: (state) => ({ ...state, folioOriginTabId }),
        });
      });
    },
    [activeTabId, navigate, openTab, pathname],
  );
}
