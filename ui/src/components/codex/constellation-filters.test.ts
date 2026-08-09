import { describe, expect, it } from "vitest";
import { applyFilters } from "./constellation-filters";

const graph = {
  nodes: [
    { id: "a", path: "alpha.md", title: "Alpha" },
    { id: "b", path: "beta.md", title: "Beta" },
    { id: "c", path: "journals/2026-04-28.md", title: "Diurnal" },
    { id: "d", path: "delta.md", title: "Delta" }, // orphan
  ],
  edges: [
    { source: "a", target: "b", kind: "wikilink" },
    { source: "a", target: "c", kind: "wikilink" },
  ],
};

describe("applyFilters", () => {
  it("includes orphans by default", () => {
    const out = applyFilters(graph, {
      orphansVisible: true,
      hideDaily: false,
      depth: null,
      anchorId: null,
    });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("excludes orphans when toggled off", () => {
    const out = applyFilters(graph, {
      orphansVisible: false,
      hideDaily: false,
      depth: null,
      anchorId: null,
    });
    expect(out.nodes.map((n) => n.id)).not.toContain("d");
  });

  it("hides daily journal nodes when toggled", () => {
    const out = applyFilters(graph, {
      orphansVisible: true,
      hideDaily: true,
      depth: null,
      anchorId: null,
    });
    expect(out.nodes.map((n) => n.id)).not.toContain("c");
    // edges referring to removed nodes are dropped
    expect(out.edges.find((e) => e.target === "c")).toBeUndefined();
  });

  it("limits to N hops from anchor when depth is set", () => {
    const extended = {
      nodes: [
        ...graph.nodes,
        { id: "e", path: "epsilon.md", title: "Epsilon" },
      ],
      edges: [...graph.edges, { source: "b", target: "e", kind: "wikilink" }],
    };
    const out = applyFilters(extended, {
      orphansVisible: true,
      hideDaily: false,
      depth: 1,
      anchorId: "a",
    });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("includes exactly two hops around an anchor", () => {
    const extended = {
      nodes: [
        ...graph.nodes,
        { id: "e", path: "epsilon.md", title: "Epsilon" },
      ],
      edges: [...graph.edges, { source: "b", target: "e", kind: "wikilink" }],
    };

    const out = applyFilters(extended, {
      orphansVisible: true,
      hideDaily: false,
      depth: 2,
      anchorId: "a",
    });

    expect(out.nodes.map((node) => node.id)).toEqual(["a", "b", "c", "e"]);
    expect(out.edges).toHaveLength(3);
  });

  it("excludes journals before traversing an anchor neighborhood", () => {
    const extended = {
      nodes: [
        ...graph.nodes,
        { id: "e", path: "epsilon.md", title: "Epsilon" },
      ],
      edges: [...graph.edges, { source: "b", target: "e", kind: "wikilink" }],
    };

    const out = applyFilters(extended, {
      orphansVisible: true,
      hideDaily: true,
      depth: 2,
      anchorId: "a",
    });

    expect(out.nodes.map((node) => node.id)).toEqual(["a", "b", "e"]);
    expect(out.edges.every((edge) => edge.source !== "c" && edge.target !== "c")).toBe(true);
  });

  it("excludes an orphan selected as the anchor when orphans are hidden", () => {
    const visible = applyFilters(graph, {
      orphansVisible: true,
      hideDaily: false,
      depth: 1,
      anchorId: "d",
    });
    const hidden = applyFilters(graph, {
      orphansVisible: false,
      hideDaily: false,
      depth: 1,
      anchorId: "d",
    });

    expect(visible.nodes.map((node) => node.id)).toEqual(["d"]);
    expect(hidden).toEqual({ nodes: [], edges: [] });
  });

  it("returns stable neighborhoods with no edges to filtered nodes", () => {
    const malformed = {
      nodes: graph.nodes,
      edges: [
        { source: "b", target: "missing", kind: "wikilink" },
        ...graph.edges,
      ],
    };
    const options = {
      orphansVisible: true,
      hideDaily: false,
      depth: 1,
      anchorId: "a",
    };

    const first = applyFilters(malformed, options);
    const second = applyFilters(malformed, options);

    expect(first).toEqual(second);
    expect(first.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(first.edges).toEqual([
      { source: "a", target: "b", kind: "wikilink" },
      { source: "a", target: "c", kind: "wikilink" },
    ]);
  });
});
