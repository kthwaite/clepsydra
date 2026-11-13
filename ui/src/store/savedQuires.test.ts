import { beforeEach, describe, expect, it } from "vitest";
import type { SavedQuireSnapshot } from "#/store/quires";
import {
  registerWorkspaceTransitionGuard,
  useWorkspaceStore,
} from "#/store/workspace";

function snapshot(): SavedQuireSnapshot {
  return {
    id: "saved-research",
    name: "Research",
    color: "indigo",
    revision: "revision-1",
    members: [
      { page_id: "page-b", path: "notes/b.md", label: "Beta", missing: false },
      { page_id: "page-a", path: "notes/a.md", label: "Alpha", missing: false },
    ],
  };
}

beforeEach(() => {
  useWorkspaceStore.getState().clearWorkspace();
  useWorkspaceStore.setState({ navigationMode: "replace" });
});

describe("opening saved quires", () => {
  it("restores ordered members by identity without replacing unrelated tabs", () => {
    useWorkspaceStore.setState({
      tabs: [
        { id: "unrelated", type: "page", path: "other.md", label: "Other" },
        {
          id: "alpha-tab",
          type: "page",
          pageId: "page-a",
          path: "old-a.md",
          label: "Old Alpha",
          quireId: "old-group",
        },
        { id: "graph", type: "graph", label: "Graph" },
        { id: "beta-tab", type: "page", path: "notes/b.md", label: "Beta" },
      ],
      activeTabId: "unrelated",
      quires: {
        "old-group": {
          id: "old-group",
          name: "Old",
          color: "sepia",
          collapsed: true,
        },
      },
    });

    useWorkspaceStore.getState().openSavedQuire(snapshot());

    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual([
      "unrelated",
      "graph",
      "beta-tab",
      "alpha-tab",
    ]);
    expect(state.tabs.map((tab) => tab.path)).toEqual([
      "other.md",
      undefined,
      "notes/b.md",
      "notes/a.md",
    ]);
    expect(state.tabs[2].pageId).toBe("page-b");
    expect(state.tabs[3].label).toBe("Alpha");
    expect(state.activeTabId).toBe("beta-tab");
    expect(Object.values(state.quires)).toEqual([
      expect.objectContaining({
        name: "Research",
        color: "indigo",
        collapsed: false,
        savedId: "saved-research",
        savedRevision: "revision-1",
      }),
    ]);
    expect(state.openHistory[0].path).toBe("notes/b.md");
  });

  it("reuses the open instance and keeps subsequently browsed pages outside the restored group", () => {
    const saved = snapshot();
    const original = structuredClone(saved);
    useWorkspaceStore.getState().openSavedQuire(saved);
    const first = useWorkspaceStore.getState();
    const group = Object.values(first.quires)[0];
    const memberIds = first.tabs.map((tab) => tab.id);
    useWorkspaceStore
      .getState()
      .openTab("page", "extra.md", "Extra", { mode: "new" });
    useWorkspaceStore.getState().renameQuire(group.id, "Working name");
    useWorkspaceStore.getState().recolorQuire(group.id, "madder");

    useWorkspaceStore.getState().openSavedQuire(saved);

    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((tab) => tab.path)).toEqual([
      "notes/b.md",
      "notes/a.md",
      "extra.md",
    ]);
    expect(state.tabs.slice(0, 2).map((tab) => tab.id)).toEqual(memberIds);
    expect(state.tabs[2].quireId).toBeUndefined();
    expect(state.quires[group.id]).toMatchObject({
      name: "Research",
      color: "indigo",
    });
    expect(saved).toEqual(original);
    state.closeQuireTabs(group.id);
    expect(useWorkspaceStore.getState().tabs.map((tab) => tab.path)).toEqual([
      "extra.md",
    ]);
    useWorkspaceStore.getState().openSavedQuire(saved);
    expect(useWorkspaceStore.getState().tabs.map((tab) => tab.path)).toEqual([
      "extra.md",
      "notes/b.md",
      "notes/a.md",
    ]);
    expect(saved).toEqual(original);
  });

  it("leaves missing references in the snapshot and does nothing when all are unavailable", () => {
    const saved = snapshot();
    saved.members[0].missing = true;
    saved.members[1].missing = true;
    useWorkspaceStore.getState().openTab("page", "other.md", "Other");
    const before = useWorkspaceStore.getState();
    useWorkspaceStore.getState().openSavedQuire(saved);
    expect(useWorkspaceStore.getState()).toBe(before);

    saved.members[1].missing = false;
    useWorkspaceStore.getState().openSavedQuire(saved);
    expect(useWorkspaceStore.getState().tabs.map((tab) => tab.path)).toEqual([
      "other.md",
      "notes/a.md",
    ]);
    expect(saved.members[0]).toEqual({
      page_id: "page-b",
      path: "notes/b.md",
      label: "Beta",
      missing: true,
    });
  });

  it("never rebinds an existing identified tab to another page at the same path", () => {
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "old",
          type: "page",
          pageId: "old-id",
          path: "notes/b.md",
          label: "Original page",
        },
      ],
      activeTabId: "old",
    });
    useWorkspaceStore.getState().openSavedQuire(snapshot());
    const state = useWorkspaceStore.getState();
    expect(state.tabs.find((tab) => tab.id === "old")).toEqual({
      id: "old",
      type: "page",
      pageId: "old-id",
      path: "notes/b.md",
      label: "Original page",
    });
    expect(
      state.tabs.filter((tab) => tab.quireId).map((tab) => tab.pageId),
    ).toEqual(["page-b", "page-a"]);
  });

  it("defers the entire restore until the unsaved-edit guard permits navigation", () => {
    useWorkspaceStore.getState().openTab("page", "draft.md", "Draft");
    const before = useWorkspaceStore.getState();
    let resume = () => {};
    const unregister = registerWorkspaceTransitionGuard((proceed) => {
      resume = proceed;
      return true;
    });
    try {
      useWorkspaceStore.getState().openSavedQuire(snapshot());
      expect(useWorkspaceStore.getState()).toBe(before);
      resume();
      expect(useWorkspaceStore.getState().tabs.map((tab) => tab.path)).toEqual([
        "draft.md",
        "notes/b.md",
        "notes/a.md",
      ]);
    } finally {
      unregister();
    }
  });
});
