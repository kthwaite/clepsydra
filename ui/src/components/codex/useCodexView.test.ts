import { describe, expect, it } from "vitest";
import { resolveCodexView } from "#/components/codex/useCodexView";
import type { TabDescriptor } from "#/store/workspace";

const pageTab: TabDescriptor = {
  id: "page:notes/alpha.md",
  type: "page",
  path: "notes/alpha.md",
  label: "Alpha",
};
const graphTab: TabDescriptor = {
  id: "graph",
  type: "graph",
  label: "Constellation",
};

describe("resolveCodexView", () => {
  it.each([
    ["/", "atrium"],
    ["/gazetteer", "gazetteer"],
    ["/docs/getting-started", "docs"],
    ["/bases", "bases"],
    ["/bases/reading-log/edit", "bases"],
    ["/tasking", "tasking"],
  ] as const)("resolves %s to %s", (pathname, expected) => {
    expect(resolveCodexView(pathname, [], null)).toBe(expected);
  });

  it("resolves a page workspace to Folio", () => {
    expect(
      resolveCodexView("/workspace", [pageTab, graphTab], pageTab.id),
    ).toBe("folio");
  });

  it("resolves a graph workspace to Constellation", () => {
    expect(
      resolveCodexView("/workspace", [pageTab, graphTab], graphTab.id),
    ).toBe("constellation");
  });
});
