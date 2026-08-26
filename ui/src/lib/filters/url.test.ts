import { describe, expect, it } from "vitest";
import { FLAG_ON } from "./model";
import {
  canonicalizeFilterSearch,
  filterStateToSearch,
  mergeFilterSearch,
  parseFilterSearch,
  shouldReplaceFilterHistory,
} from "./url";

const opts = {
  fields: [
    { id: "tags", kind: "multi" as const },
    {
      id: "kind",
      kind: "single" as const,
      normalize: (v: string) => v.toUpperCase(),
    },
    { id: "hold", kind: "flag" as const },
  ],
  aliases: { tag: "tags" },
};

describe("parseFilterSearch", () => {
  it("reads arrays, comma-joins, and aliases with trim + dedupe", () => {
    expect(
      parseFilterSearch({ tags: ["a", "b", "a"] }, opts).facets.tags,
    ).toEqual(["a", "b"]);
    expect(parseFilterSearch({ tags: " a ,b,, a" }, opts).facets.tags).toEqual([
      "a",
      "b",
    ]);
    expect(parseFilterSearch({ tag: "legacy" }, opts).facets.tags).toEqual([
      "legacy",
    ]);
  });

  it("normalizes values and truncates single fields to one value", () => {
    const s = parseFilterSearch({ kind: ["note", "book"] }, opts);
    expect(s.facets.kind).toEqual(["NOTE"]);
  });

  it("parses flags from '1'/'true'/true/1 and rejects everything else", () => {
    expect(parseFilterSearch({ hold: "1" }, opts).facets.hold).toEqual([
      FLAG_ON,
    ]);
    expect(parseFilterSearch({ hold: "true" }, opts).facets.hold).toEqual([
      FLAG_ON,
    ]);
    expect(parseFilterSearch({ hold: true }, opts).facets.hold).toEqual([
      FLAG_ON,
    ]);
    expect(parseFilterSearch({ hold: 1 }, opts).facets.hold).toEqual([FLAG_ON]);
    expect("hold" in parseFilterSearch({ hold: "0" }, opts).facets).toBe(false);
    expect("hold" in parseFilterSearch({}, opts).facets).toBe(false);
  });

  it("reads q as text and ignores unknown params", () => {
    const s = parseFilterSearch({ q: "hello", bogus: "x" }, opts);
    expect(s.text).toBe("hello");
    expect(Object.keys(s.facets)).toEqual([]);
  });

  it("drops blank and non-string values", () => {
    expect(
      "tags" in parseFilterSearch({ tags: ["", 3, "  "] }, opts).facets,
    ).toBe(false);
    expect(parseFilterSearch({ q: "" }, opts).text).toBe("");
  });
});

describe("filterStateToSearch", () => {
  it("emits every field key so stale params are overwritten", () => {
    const out = filterStateToSearch({ text: "", facets: {} }, opts);
    expect(out).toEqual({
      q: undefined,
      tags: undefined,
      kind: undefined,
      hold: undefined,
    });
  });

  it("emits arrays for multi, scalars for single and flag, q for text", () => {
    const out = filterStateToSearch(
      {
        text: "x",
        facets: { tags: ["a", "b"], kind: ["NOTE"], hold: [FLAG_ON] },
      },
      opts,
    );
    expect(out).toEqual({ q: "x", tags: ["a", "b"], kind: "NOTE", hold: "1" });
  });

  it("round-trips through parse", () => {
    const state = {
      text: "find",
      facets: { tags: ["a"], kind: ["BOOK"], hold: [FLAG_ON] },
    };
    const rt = parseFilterSearch(filterStateToSearch(state, opts), opts);
    expect(rt).toEqual(state);
  });
});

describe("canonicalizeFilterSearch", () => {
  it("preserves unrelated and alias params while emitting canonical keys", () => {
    expect(
      canonicalizeFilterSearch({ tag: "legacy", page: 2 }, opts),
    ).toEqual({
      tag: "legacy",
      page: 2,
      q: undefined,
      tags: ["legacy"],
      kind: undefined,
      hold: undefined,
    });
  });
});

describe("mergeFilterSearch", () => {
  it("preserves unrelated params and clears stale configured keys", () => {
    expect(
      mergeFilterSearch(
        { q: "old", tags: ["stale"], view: "grid" },
        { text: "new", facets: { kind: ["NOTE"] } },
        opts,
      ),
    ).toEqual({
      q: "new",
      tags: undefined,
      view: "grid",
      kind: "NOTE",
      hold: undefined,
    });
  });
});

describe("shouldReplaceFilterHistory", () => {
  it("replaces history when only text changes", () => {
    expect(
      shouldReplaceFilterHistory(
        { text: "next", facets: { tags: ["a", "b"] } },
        { text: "previous", facets: { tags: ["a", "b"] } },
      ),
    ).toBe(true);
  });

  it.each([
    [
      "a facet is added",
      { text: "next", facets: { tags: ["a"] } },
      { text: "previous", facets: {} },
    ],
    [
      "facet values are reordered",
      { text: "next", facets: { tags: ["b", "a"] } },
      { text: "next", facets: { tags: ["a", "b"] } },
    ],
  ])("pushes history when %s", (_case, next, previous) => {
    expect(shouldReplaceFilterHistory(next, previous)).toBe(false);
  });
});
