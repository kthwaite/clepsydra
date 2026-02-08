import { useGraph } from "#/api/index";
import type { GraphNode } from "#/api/types";
import { ForceGraph } from "#/components/ForceGraph";
import { useOpenTab } from "#/hooks/useOpenTab";

export function GraphTabContent() {
  const { data: graph, isLoading } = useGraph();
  const openTab = useOpenTab();

  function handleNodeClick(node: GraphNode) {
    openTab("page", node.path, node.title || node.path);
  }

  if (isLoading || !graph) {
    return <div className="p-8 text-muted-foreground">Loading graph...</div>;
  }

  if (graph.nodes.length === 0) {
    return <div className="p-8 text-muted-foreground">No pages to graph.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h1 className="text-sm font-bold uppercase tracking-widest">
          Graph ({graph.nodes.length} nodes, {graph.edges.length} edges)
        </h1>
      </div>
      <div className="flex-1">
        <ForceGraph
          nodes={graph.nodes}
          edges={graph.edges}
          onNodeClick={handleNodeClick}
        />
      </div>
    </div>
  );
}
