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
