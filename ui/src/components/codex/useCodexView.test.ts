import { describe, expect, it } from "vitest";
import {
  type RouteView,
  routeViewFromMatches,
} from "#/components/codex/useCodexView";

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
