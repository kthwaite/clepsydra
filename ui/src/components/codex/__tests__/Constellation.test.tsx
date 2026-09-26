import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphEdge, GraphNode } from "#/api/types";
import { Constellation } from "#/components/codex/Constellation";
import { useConstellationStore } from "#/store/constellation";
import { useWorkspaceStore } from "#/store/workspace";

const graph: { nodes: GraphNode[]; edges: GraphEdge[] } = {
  nodes: [
    { id: "hub", path: "projects/hub.md", title: "Hub" },
    { id: "a", path: "notes/a.md", title: "Alpha" },
    { id: "b", path: "notes/b.md", title: "Beta" },
  ],
  edges: [
    { source: "hub", target: "a", kind: "wikilink" },
    { source: "hub", target: "b", kind: "wikilink" },
  ],
};

const openTab = vi.fn();

vi.mock("#/api/index", () => ({
  useGraph: () => ({ data: graph, isLoading: false }),
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => openTab }));
vi.mock("#/hooks/useMobileLayout", () => ({ useMobileLayout: () => false }));

describe("Constellation", () => {
  beforeEach(() => {
    openTab.mockClear();
    useConstellationStore.setState({
      selectedAnchorId: null,
      depth: null,
      hideDaily: false,
      hideTasks: false,
      orphansVisible: true,
    });
    useWorkspaceStore.setState({ tabs: [], activeTabId: null });
  });

  it("titles the map with a serif heading and a sentence-case count", () => {
    render(<Constellation />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Constellation" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Map")).toBeInTheDocument();
    expect(screen.getByText("3 nodes · 2 edges")).toBeInTheDocument();
  });

  it("lists hubs by degree and opens one", async () => {
    const user = userEvent.setup();
    render(<Constellation />);
    const hubs = screen
      .getByRole("heading", { name: "Hubs" })
      .closest("section") as HTMLElement;
    const first = within(hubs).getAllByRole("button")[0];
    expect(first).toHaveTextContent("Hub2");
    await user.click(first);
    expect(openTab).toHaveBeenCalledWith("page", "projects/hub.md", "Hub");
  });

  it("toggles filters with sentence-case switches", async () => {
    const user = userEvent.setup();
    render(<Constellation />);
    await user.click(screen.getByRole("switch", { name: "Hide journals" }));
    await user.click(screen.getByRole("switch", { name: "Hide tasks" }));
    await user.click(screen.getByRole("switch", { name: "Show orphans" }));
    const s = useConstellationStore.getState();
    expect(s.hideDaily).toBe(true);
    expect(s.hideTasks).toBe(true);
    expect(s.orphansVisible).toBe(false);
  });

  it("disables depth 1 and 2 until a page is open, then names the anchor", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Constellation />);
    const depth = screen.getByRole("group", { name: "Depth" });
    expect(within(depth).getByRole("button", { name: "1" })).toBeDisabled();
    expect(within(depth).getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByText(/the open page/)).not.toBeInTheDocument();

    useWorkspaceStore.setState({
      tabs: [{ id: "t1", type: "page", path: "notes/a.md", title: "Alpha" }],
      activeTabId: "t1",
    } as never);
    rerender(<Constellation />);
    await user.click(within(depth).getByRole("button", { name: "2" }));
    expect(useConstellationStore.getState().depth).toBe(2);
    expect(screen.getByText(/, the open page/)).toHaveTextContent(
      "From Alpha, the open page",
    );
  });

  it("shows a sentence-case legend of kinds", () => {
    render(<Constellation />);
    const legend = screen
      .getByRole("heading", { name: "Legend" })
      .closest("section") as HTMLElement;
    expect(within(legend).getByText("Project")).toBeInTheDocument();
    expect(within(legend).getByText("Task")).toBeInTheDocument();
    expect(within(legend).getByText("Journal")).toBeInTheDocument();
    expect(within(legend).getByText("Note")).toBeInTheDocument();
  });
});
