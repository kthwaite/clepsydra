import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { type TabType, useWorkspaceStore } from "#/store/workspace";

export function useOpenTab() {
  const openTab = useWorkspaceStore((s) => s.openTab);
  const navigate = useNavigate();

  return useCallback(
    (type: TabType, path?: string, label?: string) => {
      openTab(type, path, label);
      navigate({ to: "/workspace" });
    },
    [openTab, navigate],
  );
}
