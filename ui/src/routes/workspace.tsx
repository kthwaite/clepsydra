import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { TabBar } from "#/components/TabBar";
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
      // Ctrl+W / Cmd+W — close active tab
      if ((e.ctrlKey || e.metaKey) && e.key === "w") {
        e.preventDefault();
        const { activeTabId } = useWorkspaceStore.getState();
        if (activeTabId) {
          closeTab(activeTabId);
        }
      }

      // Ctrl+Tab — cycle forward, Ctrl+Shift+Tab — cycle backward
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

  return (
    <div className="flex h-full flex-col">
      <TabBar />
      <div className="flex-1 overflow-y-auto">
        <TabContent />
      </div>
    </div>
  );
}
