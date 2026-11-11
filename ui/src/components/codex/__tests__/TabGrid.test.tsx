import type * as ReactRouter from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(async () => {
  // Storage must be installed before the persisted store module is evaluated.
  const { installMemoryStorage } = await import("#/test/memoryStorage");
  installMemoryStorage();
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useNavigate: () => vi.fn(),
  useRouterState: () => true,
}));
vi.mock("#/api/pages", () => ({ usePage: () => ({ data: undefined }) }));
vi.mock("#/api/index", () => ({ useBacklinks: () => ({ data: [] }) }));
vi.mock("#/api/bases", () => ({
  usePageBaseProperties: () => ({
    data: undefined,
    isPending: true,
    isError: false,
  }),
}));

import { TabGrid } from "#/components/codex/TabGrid";
import {
  registerWorkspaceTransitionGuard,
  useWorkspaceStore,
} from "#/store/workspace";

beforeEach(() => {
  useWorkspaceStore.setState({
    tabs: [
      { id: "a", type: "page", path: "a.md", label: "Alpha" },
      { id: "b", type: "page", path: "b.md", label: "Beta", quireId: "q" },
      { id: "c", type: "page", path: "c.md", label: "Gamma", quireId: "q" },
      { id: "graph", type: "graph", label: "Graph" },
    ],
    activeTabId: "a",
    quires: {
      q: { id: "q", name: "Research", color: "sepia", collapsed: true },
    },
    openHistory: [],
  });
});
afterEach(cleanup);

function setup() {
  const onClose = vi.fn();
  render(<TabGrid onClose={onClose} />);
  return { user: userEvent.setup(), onClose };
}

async function select(user: UserEvent, label: string) {
  await user.click(screen.getByRole("checkbox", { name: `Select ${label}` }));
}

describe("TabGrid", () => {
  it("includes collapsed members and selects without activating", async () => {
    const { user, onClose } = setup();
    expect(
      screen.getByRole("button", { name: "Switch to Gamma" }),
    ).toBeVisible();
    await select(user, "Beta");
    expect(useWorkspaceStore.getState().activeTabId).toBe("a");
    expect(screen.getByText("1 selected")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("switches tabs and dismisses only after transition approval", async () => {
    const { user, onClose } = setup();
    const unregister = registerWorkspaceTransitionGuard(() => true);
    try {
      await user.click(screen.getByRole("button", { name: "Switch to Beta" }));
      expect(useWorkspaceStore.getState().activeTabId).toBe("a");
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
    await user.click(screen.getByRole("button", { name: "Switch to Beta" }));
    expect(useWorkspaceStore.getState().activeTabId).toBe("b");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("creates a quire from selected pages in workspace order", async () => {
    const { user } = setup();
    await select(user, "Gamma");
    await select(user, "Alpha");
    await user.type(
      screen.getByRole("textbox", { name: "New quire name" }),
      "Writing",
    );
    await user.click(screen.getByRole("button", { name: "New quire" }));
    const state = useWorkspaceStore.getState();
    const quire = Object.values(state.quires).find((q) => q.name === "Writing");
    expect(quire).toBeDefined();
    expect(
      state.tabs
        .filter((tab) => tab.quireId === quire?.id)
        .map((tab) => tab.id),
    ).toEqual(["a", "c"]);
  });

  it("moves selected pages to an existing quire", async () => {
    const { user } = setup();
    await select(user, "Alpha");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Existing quire" }),
      "q",
    );
    await user.click(screen.getByRole("button", { name: "Add to quire" }));
    expect(
      useWorkspaceStore
        .getState()
        .tabs.filter((tab) => tab.quireId === "q")
        .map((tab) => tab.id),
    ).toEqual(["b", "c", "a"]);
  });

  it("closes only selected tabs and drops stale selections", async () => {
    const { user } = setup();
    await select(user, "Beta");
    await select(user, "Graph");
    await user.click(screen.getByRole("button", { name: "Close selected" }));
    expect(useWorkspaceStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "a",
      "c",
    ]);
    expect(screen.getByText("0 selected")).toBeVisible();
    await select(user, "Gamma");
    act(() => useWorkspaceStore.getState().closeTab("c"));
    expect(screen.getByText("0 selected")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close selected" }),
    ).toBeDisabled();
  });

  it("disables all grouping for mixed graph selections without silently dropping the graph", async () => {
    const { user } = setup();
    await select(user, "Alpha");
    await select(user, "Graph");
    await user.type(
      screen.getByRole("textbox", { name: "New quire name" }),
      "Mixed",
    );
    expect(screen.getByRole("button", { name: "New quire" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add to quire" })).toBeDisabled();
    expect(
      screen.getByText(
        "Graph tabs cannot join a quire. Deselect them to group pages.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Switch to Graph" }));
    expect(useWorkspaceStore.getState().activeTabId).toBe("graph");
  });

  it("closes individual cards and allows Done after closing the last tab", async () => {
    const { user, onClose } = setup();
    await user.click(screen.getByRole("button", { name: "Close Beta" }));
    expect(
      screen.queryByRole("button", { name: "Switch to Beta" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Close selected" }));
    expect(screen.getByText("No open tabs.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses with Escape after closing disables the bulk close control", async () => {
    const { user, onClose } = setup();
    await select(user, "Beta");
    await user.click(screen.getByRole("button", { name: "Close selected" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
