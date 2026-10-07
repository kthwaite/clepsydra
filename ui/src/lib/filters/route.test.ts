import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => router.navigate,
}));

import { FLAG_ON } from "./model";
import {
  defineFilterRoute,
  type FacetDef,
  facetFields,
  useFilterRoute,
} from "./route";

const FACETS = [
  { id: "tags", kind: "multi", label: "Tags" },
  {
    id: "kind",
    kind: "single",
    label: "Kind",
    normalize: (v) => v.toUpperCase(),
    accept: (v) => v !== "BOGUS",
    options: [{ value: "NOTE", label: "Note" }],
  },
  { id: "hold", kind: "flag", label: "Blocked" },
] as const satisfies readonly FacetDef[];

const route = defineFilterRoute({
  to: "/things",
  facets: FACETS,
  aliases: { tag: "tags" },
});

function validate(search: Record<string, unknown>) {
  return route.validateSearch(search as never) as Record<string, unknown>;
}

beforeEach(() => {
  router.navigate.mockReset();
});

describe("defineFilterRoute", () => {
  it("derives the URL spec from the facets", () => {
    expect(route.url.fields.map((f) => f.id)).toEqual(["tags", "kind", "hold"]);
    expect(route.url.aliases).toEqual({ tag: "tags" });
  });

  it("parses multi, single, flag, text and alias params", () => {
    expect(
      route.parse({ q: "find", tag: "a, b,a", kind: "note", hold: "1" }),
    ).toEqual({
      text: "find",
      facets: { tags: ["a", "b"], kind: ["NOTE"], hold: [FLAG_ON] },
    });
  });

  it("drops values the facet does not accept", () => {
    expect(route.parse({ kind: "bogus" }).facets).toEqual({});
  });

  it("canonicalizes search, keeping unrelated keys and alias links working", () => {
    expect(validate({ tag: "legacy", kind: "note,book", page: 2 })).toEqual({
      tag: "legacy",
      page: 2,
      q: undefined,
      tags: ["legacy"],
      kind: "NOTE",
      hold: undefined,
    });
  });

  it("round-trips parse → navigation → validate → parse", () => {
    const state = {
      text: "find",
      facets: { tags: ["b", "a"], kind: ["NOTE"], hold: [FLAG_ON] },
    };
    const search = validate(
      route.navigation(state, { text: "", facets: {} }).search({ view: "x" }),
    );
    expect(search).toMatchObject({
      q: "find",
      tags: ["b", "a"],
      kind: "NOTE",
      hold: "1",
      view: "x",
    });
    expect(route.parse(search)).toEqual(state);
    expect(validate(search)).toEqual(search);
  });

  it("navigates to its path, replacing history only for text-only edits", () => {
    const facets = { tags: ["a"] };
    const textOnly = route.navigation(
      { text: "new", facets },
      { text: "old", facets },
    );
    expect(textOnly.to).toBe("/things");
    expect(textOnly.replace).toBe(true);
    expect(
      route.navigation(
        { text: "", facets: { tags: ["a", "b"] } },
        { text: "", facets },
      ).replace,
    ).toBe(false);
  });

  it("clears stale facet keys and drops alias keys on navigation", () => {
    const nav = route.navigation(
      { text: "", facets: {} },
      { text: "", facets: { tags: ["legacy"] } },
    );
    const next = nav.search({ tag: "legacy", tags: ["legacy"], view: "x" });
    expect(next).toEqual({
      tag: undefined,
      q: undefined,
      tags: undefined,
      kind: undefined,
      hold: undefined,
      view: "x",
    });
    expect(route.parse(next).facets).toEqual({});
  });

  it("writes resetOnChange keys on every filter change", () => {
    const paged = defineFilterRoute({
      to: "/paged",
      facets: FACETS,
      resetOnChange: { page: 1 },
    });
    const nav = paged.navigation(
      { text: "x", facets: {} },
      { text: "", facets: {} },
    );
    expect(nav.search({ page: 4, sort: "title" })).toMatchObject({
      q: "x",
      page: 1,
      sort: "title",
    });
  });
});

describe("facetFields", () => {
  it("keeps the facet order, adds data-derived options and keeps fixed ones", () => {
    const fields = facetFields(FACETS, { tags: [{ value: "alpha" }] });
    expect(fields.map((f) => [f.id, f.kind, f.label, f.options])).toEqual([
      ["tags", "multi", "Tags", [{ value: "alpha" }]],
      ["kind", "single", "Kind", [{ value: "NOTE", label: "Note" }]],
      ["hold", "flag", "Blocked", []],
    ]);
  });
});

describe("useFilterRoute", () => {
  it("parses the search once per search object", () => {
    const search = { tags: ["a"] };
    const { result, rerender } = renderHook(
      ({ s }) => useFilterRoute(route, s),
      { initialProps: { s: search } },
    );
    const first = result.current.filterState;
    expect(first.facets).toEqual({ tags: ["a"] });
    rerender({ s: search });
    expect(result.current.filterState).toBe(first);
  });

  it("navigates filter changes against the current state", () => {
    const { result } = renderHook(() =>
      useFilterRoute(route, { q: "old", tags: ["a"] }),
    );
    act(() => {
      result.current.onFilterChange({ text: "new", facets: { tags: ["a"] } });
    });
    expect(router.navigate).toHaveBeenCalledOnce();
    const nav = router.navigate.mock.calls[0][0];
    expect(nav.to).toBe("/things");
    expect(nav.replace).toBe(true);
    expect(nav.search({})).toMatchObject({ q: "new", tags: ["a"] });
  });
});
