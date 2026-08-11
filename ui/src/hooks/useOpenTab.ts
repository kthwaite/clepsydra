import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import {
  type OpenTabTarget,
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
    (
      type: TabType,
      path?: string,
      label?: string,
      target?: OpenTabTarget,
    ) => {
      const folioOriginTabId =
        pathname === "/workspace" ? activeTabId : null;
      openTab(type, path, label, target);
      navigate({
        to: "/workspace",
        state: (state) => ({ ...state, folioOriginTabId }),
      });
    },
    [activeTabId, navigate, openTab, pathname],
  );
}
