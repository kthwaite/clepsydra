import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
