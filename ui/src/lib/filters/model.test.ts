import { describe, expect, it } from "vitest";
import {
  applyClientFilter,
  clearAllFacets,
  clearFilter,
  EMPTY_FILTER_STATE,
  FLAG_ON,
  isFilterActive,
  removeFacetValue,
  setText,
  toggleFacetValue,
} from "./model";

const multi = { id: "tags", kind: "multi" } as const;
const single = { id: "kind", kind: "single" } as const;
const flag = { id: "hold", kind: "flag" } as const;

describe("filter state helpers", () => {
  it("starts inactive and activates on text or facets", () => {
    expect(isFilterActive(EMPTY_FILTER_STATE)).toBe(false);
    expect(isFilterActive(setText(EMPTY_FILTER_STATE, "  "))).toBe(false);
    expect(isFilterActive(setText(EMPTY_FILTER_STATE, "x"))).toBe(true);
    expect(
      isFilterActive(toggleFacetValue(EMPTY_FILTER_STATE, multi, "a")),
    ).toBe(true);
  });

  it("toggles multi values in and out, deleting emptied keys", () => {
    let s = toggleFacetValue(EMPTY_FILTER_STATE, multi, "a");
    s = toggleFacetValue(s, multi, "b");
    expect(s.facets.tags).toEqual(["a", "b"]);
    s = toggleFacetValue(s, multi, "a");
    expect(s.facets.tags).toEqual(["b"]);
    s = toggleFacetValue(s, multi, "b");
    expect("tags" in s.facets).toBe(false);
  });

  it("single fields replace, and toggle off on the same value", () => {
    let s = toggleFacetValue(EMPTY_FILTER_STATE, single, "NOTE");
    expect(s.facets.kind).toEqual(["NOTE"]);
    s = toggleFacetValue(s, single, "BOOK");
    expect(s.facets.kind).toEqual(["BOOK"]);
    s = toggleFacetValue(s, single, "BOOK");
    expect("kind" in s.facets).toBe(false);
  });

  it("flag fields toggle FLAG_ON regardless of the value argument", () => {
    let s = toggleFacetValue(EMPTY_FILTER_STATE, flag, "anything");
    expect(s.facets.hold).toEqual([FLAG_ON]);
    s = toggleFacetValue(s, flag, FLAG_ON);
    expect("hold" in s.facets).toBe(false);
  });

  it("removeFacetValue and clear helpers behave", () => {
    let s = toggleFacetValue(EMPTY_FILTER_STATE, multi, "a");
    s = setText(s, "q");
    s = removeFacetValue(s, "tags", "a");
    expect("tags" in s.facets).toBe(false);
    expect(clearAllFacets(s).text).toBe("q");
    expect(isFilterActive(clearFilter(s))).toBe(false);
  });
});

interface Item {
  name: string;
  project?: string;
  tags: string[];
  hold?: string;
}
const items: Item[] = [
  { name: "Alpha", project: "clepsydra", tags: ["rust", "ui"] },
  { name: "Beta", project: "xxii", tags: ["ui"], hold: "waiting" },
  { name: "Gamma", tags: [] },
];
const config = {
  textHay: (i: Item) => i.name,
  accessors: {
    project: (i: Item) => (i.project ? [i.project] : []),
    tags: (i: Item) => i.tags,
    hold: (i: Item) => (i.hold ? [FLAG_ON] : []),
  },
};

describe("applyClientFilter", () => {
  it("returns items unchanged when inactive", () => {
    expect(applyClientFilter(items, EMPTY_FILTER_STATE, config)).toEqual(items);
  });

  it("ORs within a field and ANDs across fields", () => {
    const orState = {
      text: "",
      facets: { project: ["clepsydra", "xxii"] },
    };
    expect(
      applyClientFilter(items, orState, config).map((i) => i.name),
    ).toEqual(["Alpha", "Beta"]);
    const andState = {
      text: "",
      facets: { project: ["clepsydra", "xxii"], tags: ["rust"] },
    };
    expect(
      applyClientFilter(items, andState, config).map((i) => i.name),
    ).toEqual(["Alpha"]);
  });

  it("matches text case-insensitively and composes with facets", () => {
    const s = { text: "beT", facets: { tags: ["ui"] } };
    expect(applyClientFilter(items, s, config).map((i) => i.name)).toEqual([
      "Beta",
    ]);
  });

  it("applies flag facets through their accessor", () => {
    const s = { text: "", facets: { hold: [FLAG_ON] } };
    expect(applyClientFilter(items, s, config).map((i) => i.name)).toEqual([
      "Beta",
    ]);
  });

  it("ignores active facet keys that have no accessor", () => {
    const s = { text: "", facets: { unknown: ["x"] } };
    expect(applyClientFilter(items, s, config)).toEqual(items);
  });
});
