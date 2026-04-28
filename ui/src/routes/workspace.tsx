import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { TabContent } from "#/components/TabContent";
import { useWorkspaceStore } from "#/store/workspace";

export const Route = createFileRoute("/workspace")({
  component: Workspace,
});

function Workspace() {
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const activateTab = useWorkspaceStore((s) => s.activateTab);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "w") {
        e.preventDefault();
        const { activeTabId } = useWorkspaceStore.getState();
        if (activeTabId) closeTab(activeTabId);
      }

      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const { tabs, activeTabId } = useWorkspaceStore.getState();
        if (tabs.length < 2) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        const next = e.shiftKey
          ? (idx - 1 + tabs.length) % tabs.length
          : (idx + 1) % tabs.length;
        activateTab(tabs[next].id);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeTab, activateTab]);

  return <TabContent />;
}
