import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphEdge, GraphNode } from "#/api/types";
import { ForceGraph } from "#/components/ForceGraph";

const alpha: GraphNode = {
  id: "alpha-id",
  path: "journals/alpha.md",
  title: "Alpha",
  kind: "PROJECT",
};
const beta: GraphNode = {
  id: "beta-id",
  path: "notes/beta.md",
  title: "Beta",
  kind: "NOTE",
};
const gamma: GraphNode = {
  id: "gamma-id",
  path: "notes/gamma.md",
  title: "Gamma",
  kind: "TASK",
};
const nodes = [alpha, beta, gamma];
const edges: GraphEdge[] = [
  { source: alpha.id, target: beta.id, kind: "wikilink" },
  { source: beta.id, target: gamma.id, kind: "property_ref" },
];

function graphSurface() {
  return screen.getByLabelText("Constellation graph");
}

function geometry() {
  return screen
    .getAllByRole("button")
    .map((node) => node.getAttribute("transform"));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ForceGraph interaction", () => {
  it("selects with click, Enter and Space, previews on hover/focus, and never opens a page", () => {
    const onNodeSelect = vi.fn();
    const onNodeHover = vi.fn();
    render(
      <ForceGraph
        nodes={nodes}
        edges={edges}
        onNodeSelect={onNodeSelect}
        onNodeHover={onNodeHover}
      />,
    );
    const button = screen.getByRole("button", { name: "Alpha" });
    expect(button).toHaveAttribute("tabindex", "0");
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(onNodeHover).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: alpha.id }),
    );
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    expect(onNodeHover).toHaveBeenLastCalledWith(null);
    fireEvent.focus(button);
    expect(onNodeHover).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: alpha.id }),
    );
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: " " });
    expect(onNodeSelect).toHaveBeenCalledTimes(3);
    expect(onNodeSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: alpha.id }),
    );
    fireEvent.blur(button);
    expect(onNodeHover).toHaveBeenLastCalledWith(null);
    fireEvent.click(graphSurface());
    expect(onNodeSelect).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps touch selection distinct from transient hover", () => {
    const onNodeHover = vi.fn();
    const onNodeSelect = vi.fn();
    render(
      <ForceGraph
        nodes={nodes}
        edges={edges}
        onNodeHover={onNodeHover}
        onNodeSelect={onNodeSelect}
      />,
    );
    const button = screen.getByRole("button", { name: "Alpha" });
    const enter = new Event("pointerenter");
    Object.defineProperty(enter, "pointerType", { value: "touch" });
    fireEvent(button, enter);
    fireEvent.click(button);
    expect(onNodeHover).not.toHaveBeenCalled();
    expect(onNodeSelect).toHaveBeenCalledOnce();
  });

  it("dims and restores unrelated nodes, labels and edges without removing or moving them", () => {
    const { rerender } = render(<ForceGraph nodes={nodes} edges={edges} />);
    const initialGeometry = geometry();
    const gammaButton = screen.getByRole("button", { name: "Gamma" });
    const gammaLabel = screen.getByText("Gamma", { selector: "text" });
    const neighbourEdge = graphSurface().querySelector(
      'line[data-source="alpha-id"][data-target="beta-id"]',
    );
    const unrelatedEdge = graphSurface().querySelector(
      'line[data-source="beta-id"][data-target="gamma-id"]',
    );
    const normalOpacity = Number(neighbourEdge?.getAttribute("stroke-opacity"));
    rerender(
      <ForceGraph
        nodes={nodes}
        edges={edges}
        focusedIds={new Set([alpha.id, beta.id])}
        selectedNodeId={alpha.id}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(gammaButton).toHaveAttribute("opacity", "0.18");
    expect(gammaButton).toContainElement(gammaLabel);
    expect(Number(neighbourEdge?.getAttribute("stroke-opacity"))).toBe(
      normalOpacity,
    );
    expect(Number(unrelatedEdge?.getAttribute("stroke-opacity"))).toBeLessThan(
      normalOpacity,
    );
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(geometry()).toEqual(initialGeometry);
    rerender(
      <ForceGraph
        nodes={nodes}
        edges={edges}
        focusedIds={null}
        selectedNodeId={alpha.id}
      />,
    );
    expect(gammaButton).toHaveAttribute("opacity", "1");
    expect(Number(unrelatedEdge?.getAttribute("stroke-opacity"))).toBe(
      normalOpacity,
    );
    expect(geometry()).toEqual(initialGeometry);
  });

  it("preserves pan/zoom and positions when focus and callbacks change, even with equal copied data", () => {
    const { rerender } = render(<ForceGraph nodes={nodes} edges={edges} />);
    const surface = graphSurface();
    fireEvent.wheel(surface, { deltaY: -300, clientX: 30, clientY: 40 });
    const viewport = surface.querySelector(":scope > g");
    const transform = viewport?.getAttribute("transform");
    const positions = geometry();
    expect(transform).toContain("scale(");
    const onNodeSelect = vi.fn();
    rerender(
      <ForceGraph
        nodes={nodes.map((node) => ({ ...node }))}
        edges={edges.map((edge) => ({ ...edge }))}
        focusedIds={new Set([beta.id])}
        onNodeSelect={onNodeSelect}
      />,
    );
    expect(viewport).toHaveAttribute("transform", transform);
    expect(geometry()).toEqual(positions);
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(onNodeSelect).toHaveBeenCalledOnce();
  });

  it("retains at least a 44px hit area when zoomed out", () => {
    render(<ForceGraph nodes={nodes} edges={edges} />);
    fireEvent.wheel(graphSurface(), {
      deltaY: 100_000,
      clientX: 0,
      clientY: 0,
    });
    const target = screen
      .getByRole("button", { name: "Alpha" })
      .querySelector("rect");
    expect(Number(target?.getAttribute("width")) * 0.1).toBeGreaterThanOrEqual(
      44,
    );
    expect(Number(target?.getAttribute("height")) * 0.1).toBeGreaterThanOrEqual(
      44,
    );
  });

  it("uses the authoritative kind rather than the misleading journal path", () => {
    render(<ForceGraph nodes={[alpha]} edges={[]} />);
    const glyph = screen
      .getByRole("button", { name: "Alpha" })
      .querySelector("path");
    expect(glyph).toHaveAttribute("d", "M-6 -6h12v12h-12Z");
    expect(glyph).toHaveAttribute("fill", "var(--accent)");
  });
});

describe("ForceGraph layout", () => {
  it("settles without ongoing animation and keeps focus changes from reheating a settled graph", async () => {
    const { rerender } = render(<ForceGraph nodes={nodes} edges={edges} />);
    await waitFor(
      () => expect(graphSurface()).toHaveAttribute("aria-busy", "false"),
      { timeout: 8000 },
    );
    const settled = geometry();
    expect(
      settled.every((position) => position && !position.includes("NaN")),
    ).toBe(true);
    rerender(
      <ForceGraph
        nodes={nodes}
        edges={edges}
        focusedIds={new Set([alpha.id])}
      />,
    );
    expect(graphSurface()).toHaveAttribute("aria-busy", "false");
    expect(geometry()).toEqual(settled);
    const target = screen.getByRole("button", { name: "Alpha" });
    const mouse = (type: string, element: Element | Window) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: 0,
        clientY: 0,
      });
      // jsdom rejects its Vitest-proxied Window in MouseEventInit.view.
      Object.defineProperty(event, "view", { value: window });
      fireEvent(element, event);
    };
    mouse("mousedown", target);
    expect(graphSurface()).toHaveAttribute("aria-busy", "false");
    mouse("mouseup", window);
    expect(graphSurface()).toHaveAttribute("aria-busy", "false");
    expect(geometry()).toEqual(settled);
  });

  it("does not animate intermediate positions for reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    );
    render(<ForceGraph nodes={nodes} edges={edges} />);
    const initial = geometry();
    await new Promise<number>((resolve) => requestAnimationFrame(resolve));
    if (graphSurface().getAttribute("aria-busy") === "true") {
      expect(geometry()).toEqual(initial);
    }
    await waitFor(
      () => expect(graphSurface()).toHaveAttribute("aria-busy", "false"),
      { timeout: 8000 },
    );
    expect(
      geometry().every((position) => position && !position.includes("NaN")),
    ).toBe(true);
  });

  it.each(["kind", "folder"] as const)(
    "groups related pages by %s without removing any pages",
    async (groupBy) => {
      const grouped: GraphNode[] = [
        {
          id: "p1",
          path: "projects/one.md",
          title: "Project one",
          kind: "PROJECT",
        },
        { id: "n1", path: "notes/one.md", title: "Note one", kind: "NOTE" },
        {
          id: "p2",
          path: "projects/two.md",
          title: "Project two",
          kind: "PROJECT",
        },
        { id: "n2", path: "notes/two.md", title: "Note two", kind: "NOTE" },
      ];
      render(<ForceGraph nodes={grouped} edges={[]} groupBy={groupBy} />);
      await waitFor(
        () => expect(graphSurface()).toHaveAttribute("aria-busy", "false"),
        { timeout: 8000 },
      );
      const points = geometry().map((transform) => {
        const match = transform?.match(/translate\(([-\d.e+]+),([-\d.e+]+)\)/);
        if (!match) throw new Error("Node has no position");
        return { x: Number(match[1]), y: Number(match[2]) };
      });
      expect(points).toHaveLength(4);
      const sameGroupDistance = Math.hypot(
        points[0].x - points[2].x,
        points[0].y - points[2].y,
      );
      const otherGroupDistance = Math.hypot(
        points[0].x - points[1].x,
        points[0].y - points[1].y,
      );
      expect(sameGroupDistance).toBeLessThan(otherGroupDistance);
    },
  );

  it("fits a larger multi-hub graph without dropping nodes and reveals labels on keyboard focus", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 600),
    );
    const many = Array.from({ length: 240 }, (_, index) => ({
      id: `node-${index}`,
      path: `notes/${index}.md`,
      title: `Long descriptive note title ${index}`,
      kind: "NOTE" as const,
    }));
    const links: GraphEdge[] = many.slice(4).map((node, index) => ({
      source: `node-${index % 4}`,
      target: node.id,
      kind: "wikilink",
    }));
    render(<ForceGraph nodes={many} edges={links} groupBy="folder" />);
    expect(screen.getAllByRole("button")).toHaveLength(240);
    expect(graphSurface().querySelectorAll("line")).toHaveLength(236);
    expect(
      geometry().every((position) => position && !position.includes("NaN")),
    ).toBe(true);
    await waitFor(
      () => expect(graphSurface()).toHaveAttribute("aria-busy", "false"),
      { timeout: 8000 },
    );
    const transform =
      graphSurface().querySelector(":scope > g")?.getAttribute("transform") ??
      "";
    const view = transform.match(
      /translate\(([-\d.e+]+),([-\d.e+]+)\) scale\(([-\d.e+]+)\)/,
    );
    expect(view).not.toBeNull();
    if (!view) throw new Error("Graph has no viewport transform");
    const [, offsetX, offsetY, scale] = view.map(Number);
    for (const node of screen.getAllByRole("button")) {
      const position = node
        .getAttribute("transform")
        ?.match(/translate\(([-\d.e+]+),([-\d.e+]+)\)/);
      if (!position) throw new Error("Node has no position");
      const x = Number(position[1]) * scale + offsetX;
      const y = Number(position[2]) * scale + offsetY;
      expect(x).toBeGreaterThanOrEqual(20);
      expect(x).toBeLessThanOrEqual(780);
      expect(y).toBeGreaterThanOrEqual(20);
      expect(y).toBeLessThanOrEqual(580);
    }
    const first = screen.getByRole("button", { name: many[0].title });
    expect(first.querySelector("text")).toHaveAttribute("visibility", "hidden");
    fireEvent.focus(first);
    expect(first.querySelector("text")).toHaveAttribute(
      "visibility",
      "visible",
    );
  });
});
