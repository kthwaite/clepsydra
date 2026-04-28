import { Constellation } from "#/components/codex/Constellation";
import { Folio } from "#/components/codex/Folio";
import { useWorkspaceStore } from "#/store/workspace";

export function TabContent() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!activeTab) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="cl-marg">
          No folios open. Use{" "}
          <kbd className="cl-mono border border-[var(--rule-soft)] px-1 py-[1px] text-[10px]">⌘K</kbd>{" "}
          to invoke the console.
        </p>
      </div>
    );
  }

  if (activeTab.type === "graph") {
    return <Constellation tabId={activeTab.id} />;
  }

  if (activeTab.type === "page" && activeTab.path) {
    return (
      <Folio key={activeTab.path} tabId={activeTab.id} path={activeTab.path} />
    );
  }

  return null;
}
