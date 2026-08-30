import type { GraphEdge, GraphNode } from "#/api/types";

export type FilterOptions = {
  orphansVisible: boolean;
  hideDaily: boolean;
  hideTasks?: boolean;
  depth: number | null; // null = unlimited
  anchorId: string | null; // required when depth is set
};

export function applyFilters(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  opts: FilterOptions,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let nodes = opts.hideDaily
    ? graph.nodes.filter(
        (node) =>
          !node.path.startsWith("journals/") &&
          !node.path.startsWith("ai-journals/"),
      )
    : graph.nodes;
  if (opts.hideTasks) {
    nodes = nodes.filter(
      (node) =>
        !node.path.startsWith("tasks/") &&
        !node.path.startsWith("task/") &&
        !node.path.startsWith("todos/") &&
        !node.path.startsWith("todo/"),
    );
  }
  let nodeIds = new Set(nodes.map((node) => node.id));
  let edges = graph.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );

  if (!opts.orphansVisible) {
    const connected = new Set<string>();
    for (const edge of edges) {
      connected.add(edge.source);
      connected.add(edge.target);
    }
    nodes = nodes.filter((node) => connected.has(node.id));
    nodeIds = new Set(nodes.map((node) => node.id));
  }

  if (opts.depth != null && opts.anchorId) {
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      const sourceNeighbors = adjacency.get(edge.source);
      if (sourceNeighbors) sourceNeighbors.add(edge.target);
      else adjacency.set(edge.source, new Set([edge.target]));

      const targetNeighbors = adjacency.get(edge.target);
      if (targetNeighbors) targetNeighbors.add(edge.source);
      else adjacency.set(edge.target, new Set([edge.source]));
    }

    const visibleIds = new Set<string>([opts.anchorId]);
    let frontier = new Set<string>([opts.anchorId]);
    for (let hop = 0; hop < opts.depth && frontier.size > 0; hop += 1) {
      const next = new Set<string>();
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id) ?? []) {
          if (visibleIds.has(neighbor)) continue;
          visibleIds.add(neighbor);
          next.add(neighbor);
        }
      }
      frontier = next;
    }
    nodes = nodes.filter((node) => visibleIds.has(node.id));
    nodeIds = new Set(nodes.map((node) => node.id));
  }

  edges = edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );
  return { nodes, edges };
}
