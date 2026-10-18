import { useGraph } from "#/api/index";
import { ConstellationView } from "#/components/codex/ConstellationView";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useWorkspaceStore } from "#/store/workspace";

export function Constellation() {
  const { data: graph, isLoading } = useGraph();
  const openTab = useOpenTab();
  const mobile = useMobileLayout();
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const tabs = useWorkspaceStore((state) => state.tabs);
  const anchorPath = tabs.find(
    (tab) => tab.id === activeTabId && tab.type === "page",
  )?.path;
  if (isLoading || !graph) {
    return (
      <p className="p-10 text-[14px] text-mute">Plotting the constellation…</p>
    );
  }
  return (
    <ConstellationView
      graph={graph}
      mobile={mobile}
      activeAnchorId={
        graph.nodes.find((node) => node.path === anchorPath)?.id ?? null
      }
      onOpen={(node) => openTab("page", node.path, node.title || node.path)}
    />
  );
}
