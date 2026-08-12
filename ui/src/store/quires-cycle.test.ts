import { describe, expect, it } from "vitest";
import { cycleTargetId } from "#/store/quires";
import type { TabDescriptor } from "#/store/workspace";

const page = (id: string): TabDescriptor => ({
  id,
  type: "page",
  path: `${id}.md`,
  label: id,
});

describe("cycleTargetId with an active id outside the candidate list", () => {
  const tabs = [page("a"), page("b"), page("c")];
  it("enters at the first tab cycling forward", () => {
    expect(cycleTargetId(tabs, {}, "graph-tab", false)).toBe("a");
  });
  it("enters at the last tab cycling backward", () => {
    expect(cycleTargetId(tabs, {}, "graph-tab", true)).toBe("c");
  });
  it("enters a single-tab list from outside", () => {
    expect(cycleTargetId([page("a")], {}, "graph-tab", false)).toBe("a");
  });
  it("still no-ops with fewer than two tabs when active is in the list", () => {
    expect(cycleTargetId([page("a")], {}, "a", false)).toBeNull();
  });
});
