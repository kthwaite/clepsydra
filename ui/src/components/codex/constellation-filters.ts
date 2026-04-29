import type { GraphEdge, GraphNode } from "#/api/types";

export type FilterOptions = {
  orphansVisible: boolean;
  hideDaily: boolean;
  depth: number | null;     // null = unlimited
  anchorId: string | null;  // required when depth is set
};

export function applyFilters(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  opts: FilterOptions,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let nodes = graph.nodes;
  if (opts.hideDaily) {
    nodes = nodes.filter((n) => !n.path.startsWith("journals/"));
  }
  let edges = graph.edges.filter((e) => {
    const okSrc = nodes.some((n) => n.id === e.source);
    const okTgt = nodes.some((n) => n.id === e.target);
    return okSrc && okTgt;
  });
  if (!opts.orphansVisible) {
    const connected = new Set<string>();
    for (const e of edges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    nodes = nodes.filter((n) => connected.has(n.id));
  }
  if (opts.depth != null && opts.anchorId) {
    const adj = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, new Set());
      if (!adj.has(e.target)) adj.set(e.target, new Set());
      adj.get(e.source)!.add(e.target);
      adj.get(e.target)!.add(e.source);
    }
    const seen = new Set<string>([opts.anchorId]);
    let frontier = new Set<string>([opts.anchorId]);
    for (let i = 0; i < opts.depth; i++) {
      const next = new Set<string>();
      for (const id of frontier) {
        for (const nb of adj.get(id) ?? []) {
          if (!seen.has(nb)) { seen.add(nb); next.add(nb); }
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }
    nodes = nodes.filter((n) => seen.has(n.id));
    edges = edges.filter((e) => seen.has(e.source) && seen.has(e.target));
  }
  return { nodes, edges };
}
