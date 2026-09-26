import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphNode } from "#/api/types";
import { ForceGraph } from "./ForceGraph";

type D3ListenerHost = Element & {
  __on?: Array<{ name: string; type: string }>;
};

const alpha: GraphNode = {
  id: "alpha-id",
  path: "notes/alpha.md",
  title: "Alpha",
};

describe("ForceGraph", () => {
  it("uses a transparent 44px node target for click and drag while the graph surface retains pan", async () => {
    const onNodeClick = vi.fn();
    render(<ForceGraph nodes={[alpha]} edges={[]} onNodeClick={onNodeClick} />);

    const graph = await screen.findByRole("img", {
      name: "Constellation graph",
    });
    const target = graph.querySelector(".node-hit-target");
    const glyph = graph.querySelector(".node-glyph");
    const label = graph.querySelector("text");
    const node = target?.parentElement as D3ListenerHost | null;

    expect(target).not.toBeNull();
    expect(target).toHaveAttribute("width", "44");
    expect(target).toHaveAttribute("height", "44");
    expect(target).toHaveAttribute("fill", "transparent");
    expect(glyph).toHaveAttribute("pointer-events", "none");
    expect(label).toHaveAttribute("pointer-events", "none");
    expect(node?.__on).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "drag", type: "mousedown" }),
      ]),
    );
    expect((graph as D3ListenerHost).__on).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "zoom", type: "mousedown" }),
      ]),
    );

    fireEvent.click(target as Element);
    expect(onNodeClick).toHaveBeenCalledOnce();
    expect(onNodeClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "alpha-id" }),
    );

    fireEvent.click(graph);
    expect(onNodeClick).toHaveBeenCalledOnce();
  });

  it("keeps the node target at least 44px in screen space at minimum zoom", async () => {
    render(<ForceGraph nodes={[alpha]} edges={[]} />);

    const graph = await screen.findByRole("img", {
      name: "Constellation graph",
    });
    const target = graph.querySelector(".node-hit-target");
    expect(target).not.toBeNull();

    fireEvent.wheel(graph, {
      deltaY: 100_000,
      clientX: 0,
      clientY: 0,
    });

    await waitFor(() => expect(target).toHaveAttribute("width", "440"));
    expect(target).toHaveAttribute("height", "440");
    expect(target).toHaveAttribute("x", "-220");
    expect(target).toHaveAttribute("y", "-220");
  });
});

describe("ForceGraph token colours", () => {
  const root = document.documentElement;
  afterEach(() => {
    for (const name of ["--accent", "--ink-2", "--quire-ochre"]) {
      root.style.removeProperty(name);
    }
    root.classList.remove("paper");
  });

  it("paints edges, glyphs and Geist labels from the theme tokens and repaints on theme change", async () => {
    root.style.setProperty("--accent", "rgb(1, 2, 3)");
    root.style.setProperty("--ink-2", "rgb(4, 5, 6)");
    root.style.setProperty("--quire-ochre", "rgb(7, 8, 9)");
    const journal: GraphNode = {
      id: "j",
      path: "journals/2026-09-26.md",
      title: "Today",
    };
    render(
      <ForceGraph
        nodes={[alpha, journal]}
        edges={[{ source: "alpha-id", target: "j", kind: "wikilink" }]}
      />,
    );
    const graph = await screen.findByRole("img", {
      name: "Constellation graph",
    });
    const edge = graph.querySelector("line");
    const label = graph.querySelector("text");
    const ring = graph.querySelectorAll(".node-glyph")[1];

    expect(edge).toHaveAttribute("stroke", "rgb(1, 2, 3)");
    expect(label).toHaveAttribute("fill", "rgb(4, 5, 6)");
    expect(label).toHaveClass("font-sans");
    expect(label?.getAttribute("class") ?? "").not.toMatch(
      /cl-mono|muted-foreground|text-\[(9|10|11)px\]/,
    );
    expect(ring).toHaveAttribute("stroke", "rgb(7, 8, 9)");

    root.style.setProperty("--accent", "rgb(10, 11, 12)");
    root.classList.add("paper");
    await waitFor(() =>
      expect(edge).toHaveAttribute("stroke", "rgb(10, 11, 12)"),
    );
  });
});
