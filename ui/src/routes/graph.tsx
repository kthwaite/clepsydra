import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGraph } from "#/api/index";
import type { GraphNode } from "#/api/types";
import { ForceGraph } from "#/components/ForceGraph";

export const Route = createFileRoute("/graph")({
  component: GraphView,
});

function GraphView() {
  const { data: graph, isLoading } = useGraph();
  const navigate = useNavigate();

  function handleNodeClick(node: GraphNode) {
    navigate({ to: "/pages/$", params: { _splat: node.path } });
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
