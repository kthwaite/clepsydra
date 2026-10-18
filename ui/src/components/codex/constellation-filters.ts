import type { GraphEdge, GraphNode } from "#/api/types";
import type { Kind } from "#/lib/kind";

export type ConstellationGraph = { nodes: GraphNode[]; edges: GraphEdge[] };
export type FilterOptions = {
  orphansVisible: boolean;
  hiddenKinds: readonly Kind[];
  propertyRefsVisible: boolean;
  depth: number | null;
  anchorId: string | null;
};

/** Undirected context follows only the edges currently shown in the map. */
export function neighborhood(
  edges: GraphEdge[],
  anchorId: string,
  hops: number,
): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const [from, to] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      const neighbors = adjacency.get(from);
      if (neighbors) neighbors.add(to);
      else adjacency.set(from, new Set([to]));
    }
  }
  const ids = new Set([anchorId]);
  let frontier = [anchorId];
  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (ids.has(neighbor)) continue;
        ids.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return ids;
}

export function applyFilters(
  graph: ConstellationGraph,
  opts: FilterOptions,
): ConstellationGraph {
  let nodes = graph.nodes.filter(
    (node) => !opts.hiddenKinds.includes(node.kind),
  );
  let ids = new Set(nodes.map((node) => node.id));
  let edges = graph.edges.filter(
    (edge) =>
      (opts.propertyRefsVisible || edge.kind !== "property_ref") &&
      ids.has(edge.source) &&
      ids.has(edge.target),
  );
  if (!opts.orphansVisible) {
    const connected = new Set(
      edges.flatMap((edge) => [edge.source, edge.target]),
    );
    nodes = nodes.filter((node) => connected.has(node.id));
    ids = new Set(nodes.map((node) => node.id));
  }
  // A hidden or deleted anchor must not strand the map in an empty neighborhood.
  if (opts.depth !== null && opts.anchorId && ids.has(opts.anchorId)) {
    const visible = neighborhood(edges, opts.anchorId, opts.depth);
    nodes = nodes.filter((node) => visible.has(node.id));
    ids = new Set(nodes.map((node) => node.id));
    edges = edges.filter(
      (edge) => ids.has(edge.source) && ids.has(edge.target),
    );
  }
  return { nodes, edges };
}
