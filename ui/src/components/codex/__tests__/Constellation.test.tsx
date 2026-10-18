import { act, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphEdge, GraphNode } from "#/api/types";
import { Constellation } from "#/components/codex/Constellation";
import { useConstellationStore } from "#/store/constellation";
import { useWorkspaceStore } from "#/store/workspace";

const source: { nodes: GraphNode[]; edges: GraphEdge[] } = {
  nodes: [
    { id: "a", path: "tasks/a.md", title: "Alpha", kind: "NOTE" },
    { id: "b", path: "notes/b.md", title: "Beta", kind: "TASK" },
    { id: "c", path: "notes/c.md", title: "Gamma", kind: "CYCLE" },
    { id: "d", path: "notes/d.md", title: "Delta", kind: "JOURNAL" },
    { id: "o", path: "notes/o.md", title: "Orphan", kind: "NOTE" },
  ],
  edges: [
    { source: "a", target: "b", kind: "wikilink" },
    { source: "b", target: "c", kind: "property_ref" },
    { source: "c", target: "d", kind: "wikilink" },
  ],
};
let graph = source;
let mobile = false;
const openTab = vi.fn();
vi.mock("#/api/index", () => ({
  useGraph: () => ({ data: graph, isLoading: false }),
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => openTab }));
vi.mock("#/hooks/useMobileLayout", () => ({ useMobileLayout: () => mobile }));

function pages() {
  return screen.getByRole("list", { name: "Visible constellation pages" });
}
function row(name: string) {
  return within(pages())
    .getByRole("button", { name: `Focus ${name}` })
    .closest("li");
}

async function withControls(
  user: UserEvent,
  action: () => void | Promise<void>,
) {
  if (mobile)
    await user.click(
      screen.getByRole("button", { name: "Filters and details" }),
    );
  await action();
  if (mobile)
    await user.click(screen.getByRole("button", { name: "Close details" }));
}
async function toggle(user: UserEvent, name: string) {
  await withControls(user, () =>
    user.click(screen.getByRole("switch", { name })),
  );
}

describe.each([false, true])("Constellation mobile=%s", (isMobile) => {
  beforeEach(() => {
    graph = source;
    mobile = isMobile;
    openTab.mockClear();
    useConstellationStore.setState({
      selectedAnchorId: null,
      depth: null,
      hiddenKinds: [],
      propertyRefsVisible: true,
      orphansVisible: true,
      mode: "list",
      groupBy: "none",
      focusHops: 1,
      selectedNodeId: null,
    });
    useWorkspaceStore.setState({ tabs: [], activeTabId: null });
  });

  it("filters by resolved kind, not folder, and computes orphans after edge filtering", async () => {
    const user = userEvent.setup();
    render(<Constellation />);
    await toggle(user, "Task");
    expect(
      within(pages()).queryByRole("button", { name: "Focus Beta" }),
    ).not.toBeInTheDocument();
    expect(row("Alpha")).toBeInTheDocument();
    await toggle(user, "Task");
    await toggle(user, "Journal");
    await toggle(user, "Property references");
    await toggle(user, "Show orphans");
    expect(row("Alpha")).toBeInTheDocument();
    expect(
      within(pages()).queryByRole("button", { name: "Focus Orphan" }),
    ).not.toBeInTheDocument();
    expect(
      within(pages()).queryByRole("button", { name: "Focus Gamma" }),
    ).not.toBeInTheDocument();
  });

  it("pins focus without opening, dims rather than removes, restores after hover, and clears on Escape", async () => {
    const user = userEvent.setup();
    render(<Constellation />);
    await user.click(screen.getByRole("button", { name: "Focus Alpha" }));
    expect(openTab).not.toHaveBeenCalled();
    expect(within(pages()).getAllByRole("listitem")).toHaveLength(5);
    expect(row("Gamma")).toHaveClass("opacity-30");
    await user.click(screen.getByRole("button", { name: "Focus 2 hops" }));
    expect(row("Gamma")).not.toHaveClass("opacity-30");
    await toggle(user, "Property references");
    expect(row("Gamma")).toHaveClass("opacity-30");
    await user.hover(screen.getByRole("button", { name: "Focus Delta" }));
    expect(row("Alpha")).not.toHaveClass("opacity-30");
    expect(row("Beta")).toHaveClass("opacity-30");
    await user.unhover(screen.getByRole("button", { name: "Focus Delta" }));
    expect(row("Alpha")).not.toHaveClass("opacity-30");
    expect(row("Beta")).not.toHaveClass("opacity-30");
    await user.keyboard("{Escape}");
    expect(row("Gamma")).not.toHaveClass("opacity-30");
    await withControls(user, () => {
      expect(
        screen.getByRole("switch", { name: "Property references" }),
      ).not.toBeChecked();
    });
    await user.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(openTab).toHaveBeenCalledExactlyOnceWith(
      "page",
      "tasks/a.md",
      "Alpha",
    );
  });

  it("keeps All depth independent of focus and clears suppressed anchors and selections", async () => {
    const user = userEvent.setup();
    render(<Constellation />);
    await withControls(user, async () => {
      await user.click(screen.getByRole("button", { name: /Anchor page/ }));
      await user.click(
        screen.getByRole("option", { name: "Beta · notes/b.md" }),
      );
      await user.click(screen.getByRole("button", { name: "Depth 1" }));
    });
    expect(within(pages()).getAllByRole("listitem")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Focus Beta" }));
    await toggle(user, "Task");
    expect(row("Orphan")).toBeInTheDocument();
    expect(row("Delta")).not.toHaveClass("opacity-30");
    await toggle(user, "Task");
    await withControls(user, () => {
      expect(screen.getByRole("button", { name: "Depth All" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(row("Orphan")).not.toHaveClass("opacity-30");
  });

  it("selects the real graph by keyboard and keeps the same focused pages in list view", async () => {
    const user = userEvent.setup();
    render(<Constellation />);
    await user.click(screen.getByRole("button", { name: "Graph view" }));
    const chart = await screen.findByLabelText("Constellation graph");
    const alpha = within(chart).getByRole("button", { name: "Alpha" });
    alpha.focus();
    await user.keyboard("{Enter}");
    expect(alpha).toHaveAttribute("aria-pressed", "true");
    expect(openTab).not.toHaveBeenCalled();
    expect(within(chart).getAllByRole("button")).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(row("Gamma")).toHaveClass("opacity-30");
    expect(within(pages()).getAllByRole("listitem")).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "Open focused page" }));
    expect(openTab).toHaveBeenCalledExactlyOnceWith(
      "page",
      "tasks/a.md",
      "Alpha",
    );
  });

  it("does not resurrect a deleted focus after data refresh", async () => {
    const user = userEvent.setup();
    const view = render(<Constellation />);
    await user.click(screen.getByRole("button", { name: "Focus Beta" }));
    graph = {
      nodes: source.nodes.filter((node) => node.id !== "b"),
      edges: [],
    };
    view.rerender(<Constellation />);
    expect(row("Delta")).not.toHaveClass("opacity-30");
    act(() => {
      graph = source;
    });
    view.rerender(<Constellation />);
    expect(row("Delta")).not.toHaveClass("opacity-30");
  });
});
