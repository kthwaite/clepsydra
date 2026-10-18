import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphEdge, GraphNode } from "#/api/types";
import { ConstellationView } from "#/components/codex/ConstellationView";
import { useConstellationStore } from "#/store/constellation";

const graph: { nodes: GraphNode[]; edges: GraphEdge[] } = {
  nodes: Array.from({ length: 24 }, (_, index) => ({
    id: `n${index}`,
    path: `notes/${index}.md`,
    title: `Page ${index}`,
    kind: "NOTE",
  })),
  edges: [
    { source: "n0", target: "n1", kind: "wikilink" },
    { source: "n1", target: "n2", kind: "property_ref" },
  ],
};

describe("MobileConstellation", () => {
  beforeEach(() => {
    useConstellationStore.setState({
      selectedAnchorId: null,
      selectedNodeId: null,
      depth: null,
      focusHops: 1,
      hiddenKinds: [],
      propertyRefsVisible: true,
      orphansVisible: true,
      mode: "graph",
      groupBy: "none",
    });
  });

  it("shows the full dense graph and the same pages in list view without an implicit depth clamp", async () => {
    const user = userEvent.setup();
    render(
      <ConstellationView
        mobile
        graph={graph}
        activeAnchorId="n0"
        onOpen={vi.fn()}
      />,
    );
    const chart = await screen.findByLabelText("Constellation graph");
    expect(within(chart).getAllByRole("button")).toHaveLength(24);
    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(
      within(
        screen.getByRole("list", { name: "Visible constellation pages" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(24);
  });

  it("offers explicit All depth and dismissable details with a useful empty map", async () => {
    const user = userEvent.setup();
    render(
      <ConstellationView
        mobile
        graph={graph}
        activeAnchorId="n0"
        onOpen={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Filters and details" }),
    );
    const sheet = screen.getByRole("dialog", { name: "Constellation details" });
    await user.click(within(sheet).getByRole("button", { name: "Depth 1" }));
    await user.click(within(sheet).getByRole("button", { name: "Depth All" }));
    await user.click(within(sheet).getByRole("switch", { name: "Note" }));
    await user.click(
      within(sheet).getByRole("button", { name: "Close details" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("No pages match these controls.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByText("No pages match these controls.")).toBeVisible();
  });
});
