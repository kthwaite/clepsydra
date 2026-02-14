import { GraphTabContent } from "#/components/GraphTabContent";
import { PageTabContent } from "#/components/PageTabContent";
import { useWorkspaceStore } from "#/store/workspace";

export function TabContent() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!activeTab) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          No tabs open. Use the sidebar or{" "}
          <kbd className="border border-border px-1.5 py-0.5 text-xs">⌘K</kbd>{" "}
          to open a page.
        </p>
      </div>
    );
  }

  if (activeTab.type === "graph") {
    return <GraphTabContent />;
  }

  if (activeTab.type === "page" && activeTab.path) {
    return (
      <PageTabContent
        key={activeTab.path}
        tabId={activeTab.id}
        path={activeTab.path}
      />
    );
  }

  return null;
}
