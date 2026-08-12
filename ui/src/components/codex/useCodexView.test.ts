import { describe, expect, it } from "vitest";
import {
  type RouteView,
  resolveCodexView,
  routeViewFromMatches,
} from "#/components/codex/useCodexView";
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
    ["/feeds", "feeds"],
    ["/bases/reading-log/edit", "bases"],
    ["/tasking", "tasking"],
  ] as const)("resolves %s to %s", (pathname, expected) => {
    expect(resolveCodexView(pathname, [], null)).toBe(expected);
  });

  it.each(["/feeds-old", "/feedsfoo"])(
    "does not treat the near-prefix path %s as Feeds",
    (pathname) => {
      expect(resolveCodexView(pathname, [], null)).toBe("atrium");
    },
  );

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

const m = (codexView?: RouteView) => ({
  staticData: codexView ? { codexView } : {},
});

describe("routeViewFromMatches", () => {
  it("returns the deepest declared view", () => {
    expect(routeViewFromMatches([m("atrium"), m("docs")])).toBe("docs");
  });
  it("skips undeclared leaf matches and uses the parent", () => {
    expect(routeViewFromMatches([m("atrium"), m("docs"), m()])).toBe("docs");
  });
  it("falls back to atrium when nothing declares", () => {
    expect(routeViewFromMatches([m()])).toBe("atrium");
  });
  it("passes the workspace marker through", () => {
    expect(routeViewFromMatches([m("atrium"), m("workspace")])).toBe(
      "workspace",
    );
  });
});
