import { describe, expect, it } from "vitest";
import {
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
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, openHistory: [] });

    useWorkspaceStore.getState().openTab("page", "note-a.md", "Note A");
    expect(
      useWorkspaceStore.getState().openHistory.map((e) => e.path),
    ).toEqual(["note-a.md"]);

    useWorkspaceStore.getState().openTab("graph");
    expect(
      useWorkspaceStore.getState().openHistory.map((e) => e.path),
    ).toEqual(["note-a.md"]);
  });

  it("activateTab records page-tab activations in openHistory", () => {
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, openHistory: [] });
    const store = useWorkspaceStore.getState();
    store.addTab({ id: "t1", type: "page", path: "x.md", label: "X" });
    store.addTab({ id: "t2", type: "graph", label: "Graph" });
    useWorkspaceStore.getState().activateTab("t1");
    useWorkspaceStore.getState().activateTab("t2");
    expect(
      useWorkspaceStore.getState().openHistory.map((e) => e.path),
    ).toEqual(["x.md"]);
  });
});

describe("useWorkspaceStore updateTabPath", () => {
  it("updates the target tab's path and leaves other tabs untouched", () => {
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, openHistory: [] });
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
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, openHistory: [] });
    useWorkspaceStore
      .getState()
      .addTab({ id: "t1", type: "page", path: "notes/x.md", label: "X" });

    useWorkspaceStore.getState().updateTabPath("t1", "projects/x.md", "Moved");

    const t1 = useWorkspaceStore.getState().tabs.find((t) => t.id === "t1");
    expect(t1?.path).toBe("projects/x.md");
    expect(t1?.label).toBe("Moved");
  });

  it("removes the old path from openHistory and adds the new one", () => {
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, openHistory: [] });
    const store = useWorkspaceStore.getState();
    // openTab seeds openHistory for page tabs.
    store.openTab("page", "notes/x.md", "X");
    expect(
      useWorkspaceStore.getState().openHistory.map((e) => e.path),
    ).toEqual(["notes/x.md"]);

    const tabId = useWorkspaceStore.getState().tabs[0].id;
    useWorkspaceStore.getState().updateTabPath(tabId, "projects/x.md");

    const paths = useWorkspaceStore
      .getState()
      .openHistory.map((e) => e.path);
    expect(paths).toContain("projects/x.md");
    expect(paths).not.toContain("notes/x.md");
  });
});
