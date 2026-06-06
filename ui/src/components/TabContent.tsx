import { lazy, Suspense } from "react";
import { Folio } from "#/components/codex/Folio";
import { FolioBoundary } from "#/components/codex/FolioBoundary";
import { FolioLauncher } from "#/components/codex/FolioLauncher";
import { useWorkspaceStore } from "#/store/workspace";

// The graph tab pulls in d3 (force/drag/zoom/selection); keep it out of the
// main workspace chunk and load it only when a graph tab is opened.
const Constellation = lazy(() =>
  import("#/components/codex/Constellation").then((m) => ({
    default: m.Constellation,
  })),
);

export function TabContent() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!activeTab) {
    return <FolioLauncher />;
  }

  if (activeTab.type === "graph") {
    return (
      <Suspense
        fallback={
          <div className="cl-marg p-6">… plotting the constellation …</div>
        }
      >
        <Constellation />
      </Suspense>
    );
  }

  if (activeTab.type === "page" && activeTab.path) {
    return (
      <FolioBoundary key={activeTab.path} path={activeTab.path}>
        <Folio tabId={activeTab.id} path={activeTab.path} />
      </FolioBoundary>
    );
  }

  return null;
}
