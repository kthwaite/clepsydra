import { describe, expect, it } from "vitest";
import {
  selectActiveTab,
  selectWorkspaceMode,
  type TabDescriptor,
  type WorkspaceState,
} from "#/store/workspace";

function state(tabs: TabDescriptor[], activeTabId: string | null): WorkspaceState {
  return { tabs, activeTabId, navigationMode: "smart", openHistory: [], quires: {} };
}

const page = (id: string, path?: string): TabDescriptor => ({
  id,
  type: "page",
  path,
  label: path ?? id,
});
const graph: TabDescriptor = { id: "g1", type: "graph", label: "Graph" };

describe("selectActiveTab", () => {
  it("returns the tab matching activeTabId", () => {
    const s = state([page("a", "notes/a.md"), graph], "g1");
    expect(selectActiveTab(s)).toBe(s.tabs[1]);
  });
  it("returns undefined when nothing is active", () => {
    expect(selectActiveTab(state([page("a", "notes/a.md")], null))).toBeUndefined();
  });
});

describe("selectWorkspaceMode", () => {
  it("is constellation when the graph tab is active", () => {
    expect(selectWorkspaceMode(state([graph], "g1"))).toBe("constellation");
  });
  it("is folio when a page tab with a path is active", () => {
    expect(selectWorkspaceMode(state([page("a", "notes/a.md")], "a"))).toBe("folio");
  });
  it("is launcher when no tab is active", () => {
    expect(selectWorkspaceMode(state([page("a", "notes/a.md")], null))).toBe("launcher");
  });
  it("is launcher when the active page tab has no path", () => {
    expect(selectWorkspaceMode(state([page("a")], "a"))).toBe("launcher");
  });
});
