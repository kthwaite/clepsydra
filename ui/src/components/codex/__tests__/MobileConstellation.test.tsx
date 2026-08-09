import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphEdge, GraphNode } from "#/api/types";
import {
  MOBILE_GRAPH_DENSITY_THRESHOLD,
  MobileConstellation,
} from "../MobileConstellation";

type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

const graph: Graph = {
  nodes: [
    { id: "alpha-id", path: "notes/alpha.md", title: "Alpha" },
    { id: "beta-id", path: "notes/beta.md", title: "Beta" },
    { id: "gamma-id", path: "notes/gamma.md", title: "Gamma" },
    {
      id: "daily-id",
      path: "journals/2026-08-08.md",
      title: "Daily",
    },
    { id: "orphan-id", path: "notes/orphan.md", title: "Orphan" },
  ],
  edges: [
    { source: "alpha-id", target: "beta-id", kind: "wikilink" },
    { source: "beta-id", target: "gamma-id", kind: "wikilink" },
    { source: "gamma-id", target: "daily-id", kind: "wikilink" },
  ],
};

function Harness({
  sourceGraph = graph,
  onOpen = vi.fn(),
}: {
  sourceGraph?: Graph;
  onOpen?: (node: GraphNode) => void;
}) {
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const [depth, setDepth] = useState<1 | 2>(1);
  const [hideDaily, setHideDaily] = useState(false);
  const [orphansVisible, setOrphansVisible] = useState(true);

  return (
    <MobileConstellation
      graph={sourceGraph}
      mode={mode}
      anchorId={anchorId}
      depth={depth}
      hideDaily={hideDaily}
      orphansVisible={orphansVisible}
      onModeChange={setMode}
      onAnchorChange={setAnchorId}
      onDepthChange={setDepth}
      onHideDailyChange={setHideDaily}
      onOrphansVisibleChange={setOrphansVisible}
      onOpen={onOpen}
    />
  );
}

async function graphTitles(): Promise<string[]> {
  const chart = await screen.findByRole("img", { name: "Constellation graph" });
  return Array.from(chart.querySelectorAll("text"), (label) => label.textContent ?? "");
}

describe("MobileConstellation", () => {
  it("limits the chart to the selected anchor and depth", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.selectOptions(screen.getByLabelText("Anchor page"), "alpha-id");

    await waitFor(async () => {
      expect((await graphTitles()).sort()).toEqual(["Alpha", "Beta"]);
    });

    await user.click(screen.getByRole("button", { name: "Depth 2" }));
    await waitFor(async () => {
      expect((await graphTitles()).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
    });
  });

  it("exposes the chart's complete visible node set as a sorted semantic list", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const chartNodeTitles = (await graphTitles()).sort();
    await user.click(screen.getByRole("button", { name: "List view" }));

    const list = screen.getByRole("list", {
      name: "Visible constellation pages",
    });
    const listNodeTitles = within(list)
      .getAllByRole("heading")
      .map((heading) => heading.textContent ?? "");

    expect(listNodeTitles).toEqual(["Alpha", "Beta", "Daily", "Gamma", "Orphan"]);
    expect([...listNodeTitles].sort()).toEqual(chartNodeTitles);
  });

  it("opens a visible node from the semantic list", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);

    await user.selectOptions(screen.getByLabelText("Anchor page"), "alpha-id");
    await user.click(screen.getByRole("button", { name: "List view" }));
    await user.click(screen.getByRole("button", { name: "Open Alpha" }));

    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "alpha-id" }),
    );
  });

  it("prompts for an anchor when the chart is dense without truncating its list", async () => {
    const user = userEvent.setup();
    const denseGraph: Graph = {
      nodes: Array.from(
        { length: MOBILE_GRAPH_DENSITY_THRESHOLD + 1 },
        (_, index) => ({
          id: `node-${index}`,
          path: `notes/page-${index}.md`,
          title: `Page ${index}`,
        }),
      ),
      edges: [],
    };
    render(<Harness sourceGraph={denseGraph} />);

    expect(
      screen.getByText(/select an anchor to plot this constellation/i),
    ).toBeVisible();
    expect(
      screen.queryByRole("img", { name: "Constellation graph" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(
      within(
        screen.getByRole("list", { name: "Visible constellation pages" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(MOBILE_GRAPH_DENSITY_THRESHOLD + 1);
  });

  it("bases the dense anchor prompt on filtered visible nodes", async () => {
    const user = userEvent.setup();
    const filteredDenseGraph: Graph = {
      nodes: [
        { id: "note-a", path: "notes/a.md", title: "A" },
        { id: "note-b", path: "notes/b.md", title: "B" },
        ...Array.from(
          { length: MOBILE_GRAPH_DENSITY_THRESHOLD - 1 },
          (_, index) => ({
            id: `daily-${index}`,
            path: `journals/2026-07-${String(index + 1).padStart(2, "0")}.md`,
            title: `Daily ${index + 1}`,
          }),
        ),
      ],
      edges: [{ source: "note-a", target: "note-b", kind: "wikilink" }],
    };
    render(<Harness sourceGraph={filteredDenseGraph} />);

    expect(
      screen.getByText(/select an anchor to plot this constellation/i),
    ).toBeVisible();

    await user.click(screen.getByRole("switch", { name: "Hide journals" }));

    const chart = await screen.findByRole("img", {
      name: "Constellation graph",
    });
    expect(chart).toBeVisible();
    expect(await graphTitles()).toEqual(["A", "B"]);
  });

  it("presents hubs and orphans in an accessible dismissable sheet", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Hubs and orphans" }));

    const sheet = screen.getByRole("dialog", {
      name: "Constellation details",
    });
    expect(
      within(sheet).getByRole("list", { name: "Hubs by degree" }),
    ).toBeVisible();
    expect(
      within(sheet).getByRole("list", { name: "Orphan pages" }),
    ).toHaveTextContent("Orphan");

    await user.click(
      within(sheet).getByRole("button", { name: "Close details" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Constellation details" }),
    ).not.toBeInTheDocument();
  });
});
