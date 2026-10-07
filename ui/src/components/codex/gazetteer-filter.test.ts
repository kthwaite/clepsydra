import { describe, expect, it } from "vitest";
import {
  GAZETTEER_FILTER,
  toContentIndexSort,
  validateGazetteerSearch,
} from "./gazetteer-filter";

describe("toContentIndexSort", () => {
  it("maps each Gazetteer sort to the server's content-index order", () => {
    expect(toContentIndexSort("ts")).toBe("updated");
    expect(toContentIndexSort("created")).toBe("created");
    expect(toContentIndexSort("title")).toBe("title");
    expect(toContentIndexSort("words")).toBe("words");
  });
});

describe("Gazetteer URL search", () => {
  it("defaults to the first page by Edited with no filters", () => {
    expect(validateGazetteerSearch({})).toEqual({
      q: undefined,
      tags: undefined,
      kind: undefined,
      project: undefined,
      sort: "ts",
      page: 1,
    });
  });

  it("keeps the existing bookmark format", () => {
    expect(
      validateGazetteerSearch({
        q: "atlas",
        tags: ["research", "pkm"],
        kind: "project",
        project: " clepsydra ",
        sort: "title",
        page: 2,
      }),
    ).toEqual({
      q: "atlas",
      tags: ["research", "pkm"],
      kind: "PROJECT",
      project: "clepsydra",
      sort: "title",
      page: 2,
    });
  });

  it("reads comma-joined and duplicate tags", () => {
    expect(validateGazetteerSearch({ tags: "a, b,a" }).tags).toEqual([
      "a",
      "b",
    ]);
  });

  it("reads the older ?tag= spelling, preferring ?tags=", () => {
    expect(validateGazetteerSearch({ tag: "legacy" }).tags).toEqual(["legacy"]);
    expect(
      validateGazetteerSearch({ tag: "legacy", tags: ["new"] }).tags,
    ).toEqual(["new"]);
  });

  it("keeps an unknown Kind for the server to reject", () => {
    expect(validateGazetteerSearch({ kind: "widget" }).kind).toBe("WIDGET");
  });

  it("falls back on an unknown sort and an invalid page", () => {
    expect(validateGazetteerSearch({ sort: "id", page: 0 })).toMatchObject({
      sort: "ts",
      page: 1,
    });
    expect(validateGazetteerSearch({ page: 3.7 }).page).toBe(3);
    expect(validateGazetteerSearch({ page: "2" }).page).toBe(1);
  });

  it("is idempotent", () => {
    const once = validateGazetteerSearch({
      q: "x",
      tag: "legacy",
      kind: "note",
      sort: "words",
      page: 4,
    });
    expect(validateGazetteerSearch(once)).toEqual(once);
  });

  it("returns to page 1 on a filter change and drops the older ?tag=", () => {
    const nav = GAZETTEER_FILTER.navigation(
      { text: "", facets: {} },
      { text: "", facets: { tags: ["legacy"] } },
    );
    const next = validateGazetteerSearch(
      nav.search({ tag: "legacy", tags: ["legacy"], sort: "title", page: 3 }),
    );
    expect(next).toMatchObject({ sort: "title", page: 1 });
    expect(next.tags).toBeUndefined();
    expect(next.tag).toBeUndefined();
  });
});
