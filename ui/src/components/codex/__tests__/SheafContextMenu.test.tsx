import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "#/store/workspace";
import { SheafContextMenu } from "../SheafContextMenu";

function seed() {
  useWorkspaceStore.setState({
    tabs: [
      { id: "t1", type: "page", path: "a.md", label: "A" },
      { id: "t2", type: "page", path: "b.md", label: "B", quireId: "q1" },
    ],
    activeTabId: "t1",
    quires: {
      q1: { id: "q1", name: "thesis", color: "sepia", collapsed: false },
    },
    openHistory: [],
  });
}

describe("SheafContextMenu — tab target", () => {
  it("creates a quire via the NEW QUIRE flow", async () => {
    seed();
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SheafContextMenu
        target={{ kind: "tab", tabId: "t1", x: 10, y: 10 }}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "NEW QUIRE…" }));
    await user.keyboard("drafts{Enter}");

    const { tabs, quires } = useWorkspaceStore.getState();
    const created = Object.values(quires).find((q) => q.name === "drafts");
    expect(created).toBeDefined();
    expect(tabs.find((t) => t.id === "t1")?.quireId).toBe(created?.id);
    expect(onClose).toHaveBeenCalled();
  });

  it("adds the tab to an existing quire", async () => {
    seed();
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SheafContextMenu
        target={{ kind: "tab", tabId: "t1", x: 10, y: 10 }}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: /add to thesis/i }));
    expect(
      useWorkspaceStore.getState().tabs.find((t) => t.id === "t1")?.quireId,
    ).toBe("q1");
  });

  it("removes a member from its quire", async () => {
    seed();
    const user = userEvent.setup();
    render(
      <SheafContextMenu
        target={{ kind: "tab", tabId: "t2", x: 10, y: 10 }}
        onClose={() => {}}
      />,
    );
    await user.click(
      screen.getByRole("menuitem", { name: "REMOVE FROM QUIRE" }),
    );
    expect(
      useWorkspaceStore.getState().tabs.find((t) => t.id === "t2")?.quireId,
    ).toBeUndefined();
  });

  it("keeps close actions without tab pin actions", () => {
    seed();
    render(
      <SheafContextMenu
        target={{ kind: "tab", tabId: "t1", x: 10, y: 10 }}
        onClose={() => {}}
      />,
    );

    expect(
      screen.queryByRole("menuitem", { name: /^(un)?pin$/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "CLOSE" })).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "CLOSE OTHERS" }),
    ).toBeVisible();
  });
});

describe("SheafContextMenu — quire target", () => {
  it("renames via the RENAME flow", async () => {
    seed();
    const user = userEvent.setup();
    render(
      <SheafContextMenu
        target={{ kind: "quire", quireId: "q1", x: 10, y: 10 }}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "RENAME…" }));
    await user.clear(screen.getByRole("textbox"));
    await user.keyboard("opus{Enter}");
    expect(useWorkspaceStore.getState().quires.q1.name).toBe("opus");
  });

  it("ungroups the quire", async () => {
    seed();
    const user = userEvent.setup();
    render(
      <SheafContextMenu
        target={{ kind: "quire", quireId: "q1", x: 10, y: 10 }}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "UNGROUP" }));
    const state = useWorkspaceStore.getState();
    expect(state.quires.q1).toBeUndefined();
    expect(state.tabs.find((t) => t.id === "t2")?.quireId).toBeUndefined();
  });

  it("recolors the quire via a swatch", async () => {
    seed();
    const user = userEvent.setup();
    render(
      <SheafContextMenu
        target={{ kind: "quire", quireId: "q1", x: 10, y: 10 }}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "recolor madder" }));
    expect(useWorkspaceStore.getState().quires.q1.color).toBe("madder");
  });

  it("closes every quire member", async () => {
    seed();
    const user = userEvent.setup();
    render(
      <SheafContextMenu
        target={{ kind: "quire", quireId: "q1", x: 10, y: 10 }}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "CLOSE QUIRE" }));
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(["t1"]);
  });
});
