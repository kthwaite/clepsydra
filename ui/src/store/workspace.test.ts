import { describe, expect, it } from "vitest";
import {
  migrateWorkspace,
  type OpenHistoryEntry,
  pushOpenHistory,
  useWorkspaceStore,
} from "./workspace";

describe("pushOpenHistory", () => {
  it("prepends the newest path", () => {
    const out = pushOpenHistory([], "a.md", 1000);
    expect(out).toEqual([{ path: "a.md", openedAt: 1000 }]);
  });

  it("de-duplicates by path, moving the existing entry to front with new time", () => {
    const start: OpenHistoryEntry[] = [
      { path: "a.md", openedAt: 1 },
      { path: "b.md", openedAt: 2 },
    ];
    const out = pushOpenHistory(start, "a.md", 3000);
    expect(out).toEqual([
      { path: "a.md", openedAt: 3000 },
      { path: "b.md", openedAt: 2 },
    ]);
  });

  it("caps the buffer at 32 entries, dropping the oldest", () => {
    let hist: OpenHistoryEntry[] = [];
    for (let i = 0; i < 40; i++) hist = pushOpenHistory(hist, `p${i}.md`, i);
    expect(hist).toHaveLength(32);
    expect(hist[0]).toEqual({ path: "p39.md", openedAt: 39 });
    expect(hist.at(-1)).toEqual({ path: "p8.md", openedAt: 8 });
  });
});

describe("useWorkspaceStore openTab wiring", () => {
  it("records page opens but not graph opens in openHistory", () => {
    useWorkspaceStore.setState({
      tabs: [],
      activeTabId: null,
      openHistory: [],
    });

    useWorkspaceStore.getState().openTab("page", "note-a.md", "Note A");
    expect(useWorkspaceStore.getState().openHistory.map((e) => e.path)).toEqual(
      ["note-a.md"],
    );

    useWorkspaceStore.getState().openTab("graph");
    expect(useWorkspaceStore.getState().openHistory.map((e) => e.path)).toEqual(
      ["note-a.md"],
    );
  });

  it("activateTab records page-tab activations in openHistory", () => {
    useWorkspaceStore.setState({
      tabs: [],
      activeTabId: null,
      openHistory: [],
    });
    const store = useWorkspaceStore.getState();
    store.addTab({ id: "t1", type: "page", path: "x.md", label: "X" });
    store.addTab({ id: "t2", type: "graph", label: "Graph" });
    useWorkspaceStore.getState().activateTab("t1");
    useWorkspaceStore.getState().activateTab("t2");
    expect(useWorkspaceStore.getState().openHistory.map((e) => e.path)).toEqual(
      ["x.md"],
    );
  });
});

describe("useWorkspaceStore block focus requests", () => {
  it("updates the focus request when reopening an existing page tab", () => {
    useWorkspaceStore.setState({
      tabs: [],
      activeTabId: null,
      navigationMode: "new",
      openHistory: [],
      quires: {},
    });
    const store = useWorkspaceStore.getState();
    store.openTab("page", "source.md", "Source");
    useWorkspaceStore
      .getState()
      .openTab("page", "source.md", "Source", { blockId: "abc123DEF0" });

    const state = useWorkspaceStore.getState();
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.focusBlockId).toBe(
      "abc123DEF0",
    );
  });

  it("sets and clears a focus request on a newly opened page tab", () => {
    useWorkspaceStore.setState({
      tabs: [],
      activeTabId: null,
      navigationMode: "new",
      openHistory: [],
      quires: {},
    });

    useWorkspaceStore
      .getState()
      .openTab("page", "source.md", "Source", { blockId: "abc123DEF0" });

    const opened = useWorkspaceStore.getState();
    const activeTab = opened.tabs.find((tab) => tab.id === opened.activeTabId);
    expect(activeTab?.focusBlockId).toBe("abc123DEF0");

    useWorkspaceStore.getState().clearTabFocus(activeTab!.id);
    expect(
      useWorkspaceStore.getState().tabs.find((tab) => tab.id === activeTab!.id)
        ?.focusBlockId,
    ).toBeUndefined();
  });

  it("claims each focus request once and permits a later request for the same block", () => {
    useWorkspaceStore.setState({
      tabs: [],
      activeTabId: null,
      navigationMode: "new",
      openHistory: [],
      quires: {},
    });
    useWorkspaceStore
      .getState()
      .openTab("page", "source.md", "Source", { blockId: "abc123DEF0" });

    const first = useWorkspaceStore.getState().tabs[0];
    expect(first.focusRequestId).toBeDefined();
    expect(
      useWorkspaceStore
        .getState()
        .takeTabFocus(first.id, first.focusRequestId!),
    ).toBe("abc123DEF0");
    expect(
      useWorkspaceStore
        .getState()
        .takeTabFocus(first.id, first.focusRequestId!),
    ).toBeUndefined();

    useWorkspaceStore
      .getState()
      .openTab("page", "source.md", "Source", { blockId: "abc123DEF0" });
    const second = useWorkspaceStore.getState().tabs[0];
    expect(second.focusRequestId).not.toBe(first.focusRequestId);
    expect(
      useWorkspaceStore
        .getState()
        .takeTabFocus(second.id, second.focusRequestId!),
    ).toBe("abc123DEF0");
  });

  it("cancels a pending request when another tab is activated", () => {
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "other",
          type: "page",
          path: "other.md",
          label: "Other",
        },
      ],
      activeTabId: "other",
      navigationMode: "new",
      openHistory: [],
      quires: {},
    });
    useWorkspaceStore
      .getState()
      .openTab("page", "source.md", "Source", { blockId: "abc123DEF0" });
    const source = useWorkspaceStore
      .getState()
      .tabs.find((tab) => tab.path === "source.md")!;

    useWorkspaceStore.getState().activateTab("other");

    expect(
      useWorkspaceStore.getState().tabs.find((tab) => tab.id === source.id)
        ?.focusBlockId,
    ).toBeUndefined();
    expect(
      useWorkspaceStore.getState().tabs.find((tab) => tab.id === source.id)
        ?.focusRequestId,
    ).toBeUndefined();
  });

  it("cancels a retained pinned request when close-other-tabs activates another tab", () => {
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "source",
          type: "page",
          path: "source.md",
          label: "Source",
          pinned: true,
          focusBlockId: "abc123DEF0",
          focusRequestId: "request-1",
        },
        {
          id: "other",
          type: "page",
          path: "other.md",
          label: "Other",
        },
      ],
      activeTabId: "source",
      navigationMode: "new",
      openHistory: [],
      quires: {},
    });

    useWorkspaceStore.getState().closeOtherTabs("other");

    const source = useWorkspaceStore
      .getState()
      .tabs.find((tab) => tab.id === "source");
    expect(useWorkspaceStore.getState().activeTabId).toBe("other");
    expect(source?.focusBlockId).toBeUndefined();
    expect(source?.focusRequestId).toBeUndefined();
  });

  it("retains a pending request when an inactive tab closes", () => {
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "other",
          type: "page",
          path: "other.md",
          label: "Other",
        },
      ],
      activeTabId: "other",
      navigationMode: "new",
      openHistory: [],
      quires: {},
    });
    useWorkspaceStore
      .getState()
      .openTab("page", "source.md", "Source", { blockId: "abc123DEF0" });

    useWorkspaceStore.getState().closeTab("other");

    const source = useWorkspaceStore
      .getState()
      .tabs.find((tab) => tab.path === "source.md");
    expect(source?.focusBlockId).toBe("abc123DEF0");
    expect(source?.focusRequestId).toBeDefined();
  });

  it("does not persist transient block focus requests", () => {
    window.localStorage.clear();
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "source",
          type: "page",
          path: "source.md",
          label: "Source",
          focusBlockId: "abc123DEF0",
          focusRequestId: "request-1",
        },
      ],
      activeTabId: "source",
      navigationMode: "new",
      openHistory: [],
      quires: {},
    });

    const persisted = JSON.parse(
      window.localStorage.getItem("clepsydra.workspace") ?? "{}",
    );
    expect(persisted.state.tabs[0].focusBlockId).toBeUndefined();
    expect(persisted.state.tabs[0].focusRequestId).toBeUndefined();
  });
});

describe("useWorkspaceStore clearActiveTab", () => {
  it("clears the active tab without removing any tabs", () => {
    useWorkspaceStore.setState({
      tabs: [],
      activeTabId: null,
      openHistory: [],
      quires: {},
    });
    const store = useWorkspaceStore.getState();
    store.addTab({ id: "g1", type: "graph", label: "Graph" });
    expect(useWorkspaceStore.getState().activeTabId).toBe("g1");

    useWorkspaceStore.getState().clearActiveTab();

    expect(useWorkspaceStore.getState().activeTabId).toBeNull();
    expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
  });
});

describe("useWorkspaceStore updateTabPath", () => {
  it("updates the target tab's path and leaves other tabs untouched", () => {
    useWorkspaceStore.setState({
      tabs: [],
      activeTabId: null,
      openHistory: [],
    });
    const store = useWorkspaceStore.getState();
    store.addTab({ id: "t1", type: "page", path: "notes/x.md", label: "X" });
    store.addTab({ id: "t2", type: "page", path: "notes/y.md", label: "Y" });

    useWorkspaceStore.getState().updateTabPath("t1", "projects/x.md");

    const tabs = useWorkspaceStore.getState().tabs;
    const t1 = tabs.find((t) => t.id === "t1");
    const t2 = tabs.find((t) => t.id === "t2");
    expect(t1?.path).toBe("projects/x.md");
    // label preserved when not supplied
    expect(t1?.label).toBe("X");
    // sibling untouched
    expect(t2?.path).toBe("notes/y.md");
  });

  it("updates the label too when one is supplied", () => {
    useWorkspaceStore.setState({
      tabs: [],
      activeTabId: null,
      openHistory: [],
    });
    useWorkspaceStore
      .getState()
      .addTab({ id: "t1", type: "page", path: "notes/x.md", label: "X" });

    useWorkspaceStore.getState().updateTabPath("t1", "projects/x.md", "Moved");

    const t1 = useWorkspaceStore.getState().tabs.find((t) => t.id === "t1");
    expect(t1?.path).toBe("projects/x.md");
    expect(t1?.label).toBe("Moved");
  });

  it("removes the old path from openHistory and adds the new one", () => {
    useWorkspaceStore.setState({
      tabs: [],
      activeTabId: null,
      openHistory: [],
    });
    const store = useWorkspaceStore.getState();
    // openTab seeds openHistory for page tabs.
    store.openTab("page", "notes/x.md", "X");
    expect(useWorkspaceStore.getState().openHistory.map((e) => e.path)).toEqual(
      ["notes/x.md"],
    );

    const tabId = useWorkspaceStore.getState().tabs[0].id;
    useWorkspaceStore.getState().updateTabPath(tabId, "projects/x.md");

    const paths = useWorkspaceStore.getState().openHistory.map((e) => e.path);
    expect(paths).toContain("projects/x.md");
    expect(paths).not.toContain("notes/x.md");
  });
});

describe("migrateWorkspace", () => {
  it("adds an empty quires map to v2 state", () => {
    const v2 = { tabs: [], activeTabId: null, openHistory: [] };
    const out = migrateWorkspace(v2, 2);
    expect(out.quires).toEqual({});
    expect(out.openHistory).toEqual([]);
  });

  it("adds both openHistory and quires to v1 state", () => {
    const out = migrateWorkspace({ tabs: [] }, 1);
    expect(out.openHistory).toEqual([]);
    expect(out.quires).toEqual({});
  });

  it("passes v3 state through untouched", () => {
    const v3 = { tabs: [], activeTabId: null, openHistory: [], quires: {} };
    expect(migrateWorkspace(v3, 3)).toEqual(v3);
  });
});

function resetStore() {
  useWorkspaceStore.setState({
    tabs: [],
    activeTabId: null,
    navigationMode: "smart",
    openHistory: [],
    quires: {},
  });
}

function pageTab(id: string, quireId?: string, pinned?: boolean) {
  return {
    id,
    type: "page" as const,
    path: `${id}.md`,
    label: id,
    quireId,
    pinned,
  };
}

describe("quire actions", () => {
  it("createQuire assigns membership and rotates colors", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1"), pageTab("t2")],
      activeTabId: "t1",
    });
    useWorkspaceStore.getState().createQuire("t1", "thesis");
    useWorkspaceStore.getState().createQuire("t2", "garden");

    const { tabs, quires } = useWorkspaceStore.getState();
    const list = Object.values(quires);
    expect(list.map((q) => q.name).sort()).toEqual(["garden", "thesis"]);
    expect(new Set(list.map((q) => q.color)).size).toBe(2);
    expect(tabs.find((t) => t.id === "t1")?.quireId).toBe(
      list.find((q) => q.name === "thesis")?.id,
    );
  });

  it("addTabToQuire gathers the tab into the quire run", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2"), pageTab("t3", "q1")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().addTabToQuire("t2", "q1");
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual([
      "t1",
      "t3",
      "t2",
    ]);
  });

  it("addTabToQuire is a no-op when the tab is already a member", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2", "q1"), pageTab("t3")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().addTabToQuire("t1", "q1");
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("addTabToQuire expands a collapsed quire when adding the active tab", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2")],
      activeTabId: "t2",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: true } },
    });
    useWorkspaceStore.getState().addTabToQuire("t2", "q1");
    expect(useWorkspaceStore.getState().quires.q1.collapsed).toBe(false);
  });

  it("removeTabFromQuire dissolves the quire when it empties", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().removeTabFromQuire("t1");
    const { tabs, quires } = useWorkspaceStore.getState();
    expect(tabs[0].quireId).toBeUndefined();
    expect(quires.q1).toBeUndefined();
  });

  it("toggleQuireCollapse moves activation off a hidden active tab", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2", "q1"), pageTab("t3")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().toggleQuireCollapse("q1");
    const state = useWorkspaceStore.getState();
    expect(state.quires.q1.collapsed).toBe(true);
    expect(state.activeTabId).toBe("t3");
  });

  it("toggleQuireCollapse nulls activation when nothing stays visible", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2", "q1")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().toggleQuireCollapse("q1");
    expect(useWorkspaceStore.getState().activeTabId).toBeNull();
  });

  it("closeQuireTabs closes unpinned members; pinned + quire survive", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1", true), pageTab("t2", "q1"), pageTab("t3")],
      activeTabId: "t2",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().closeQuireTabs("q1");
    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(state.quires.q1).toBeDefined();
    expect(state.activeTabId).toBe("t1");
  });

  it("closeQuireTabs dissolves a fully-unpinned quire", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2")],
      activeTabId: "t2",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().closeQuireTabs("q1");
    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(["t2"]);
    expect(state.quires.q1).toBeUndefined();
  });

  it("ungroupQuire strips membership and deletes the record", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2", "q1")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().ungroupQuire("q1");
    const state = useWorkspaceStore.getState();
    expect(state.tabs.every((t) => t.quireId === undefined)).toBe(true);
    expect(state.quires.q1).toBeUndefined();
  });

  it("renameQuire and recolorQuire update the record", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().renameQuire("q1", "renamed");
    useWorkspaceStore.getState().recolorQuire("q1", "madder");
    const q = useWorkspaceStore.getState().quires.q1;
    expect(q.name).toBe("renamed");
    expect(q.color).toBe("madder");
  });

  it("activateTab auto-expands a collapsed quire containing the target tab", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2")],
      activeTabId: "t2",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: true } },
    });
    useWorkspaceStore.getState().activateTab("t1");
    const state = useWorkspaceStore.getState();
    expect(state.activeTabId).toBe("t1");
    expect(state.quires.q1.collapsed).toBe(false);
  });
});

describe("openTab quire integration", () => {
  it("a new tab inherits the active tab's quire and lands at the end of the run", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2", "q1"), pageTab("t3")],
      activeTabId: "t1",
      navigationMode: "smart",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().openTab("page", "new.md", "New");
    const { tabs } = useWorkspaceStore.getState();
    const created = tabs.find((t) => t.path === "new.md");
    expect(created?.quireId).toBe("q1");
    expect(tabs.map((t) => t.path)).toEqual([
      "t1.md",
      "t2.md",
      "new.md",
      "t3.md",
    ]);
  });

  it("does not inherit when the active tab is ungrouped", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1")],
      activeTabId: "t1",
      navigationMode: "smart",
    });
    useWorkspaceStore.getState().openTab("page", "new.md", "New");
    expect(
      useWorkspaceStore.getState().tabs.find((t) => t.path === "new.md")
        ?.quireId,
    ).toBeUndefined();
  });

  it("replace mode keeps the slot's quire membership", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1")],
      activeTabId: "t1",
      navigationMode: "replace",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().openTab("page", "other.md", "Other");
    const t1 = useWorkspaceStore.getState().tabs.find((t) => t.id === "t1");
    expect(t1?.path).toBe("other.md");
    expect(t1?.quireId).toBe("q1");
  });

  it("focusing an existing tab hidden in a collapsed quire auto-expands it", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2")],
      activeTabId: "t2",
      navigationMode: "smart",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: true } },
    });
    useWorkspaceStore.getState().openTab("page", "t1.md");
    const state = useWorkspaceStore.getState();
    expect(state.activeTabId).toBe("t1");
    expect(state.quires.q1.collapsed).toBe(false);
  });

  it("graph tabs never inherit a quire", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1")],
      activeTabId: "t1",
      navigationMode: "smart",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().openTab("graph");
    expect(
      useWorkspaceStore.getState().tabs.find((t) => t.type === "graph")
        ?.quireId,
    ).toBeUndefined();
  });
});

describe("visibility-aware closing", () => {
  it("closeTab skips hidden neighbors when re-homing activation", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [
        pageTab("t1"),
        pageTab("t2", "q1"),
        pageTab("t3", "q1"),
        pageTab("t4"),
      ],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: true } },
    });
    useWorkspaceStore.getState().closeTab("t1");
    expect(useWorkspaceStore.getState().activeTabId).toBe("t4");
  });

  it("closeTab dissolves a quire when its last member closes", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2")],
      activeTabId: "t2",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().closeTab("t1");
    expect(useWorkspaceStore.getState().quires.q1).toBeUndefined();
  });

  it("closeOtherTabs spares pinned tabs and dead quires dissolve", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2", "q1", true), pageTab("t3")],
      activeTabId: "t3",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().closeOtherTabs("t3");
    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(state.quires.q1).toBeDefined(); // pinned member keeps it alive
  });
});
