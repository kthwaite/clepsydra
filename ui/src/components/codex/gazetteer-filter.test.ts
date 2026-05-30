import { describe, expect, it } from "vitest";
import { filterAndSortRows, type GazetteerRow } from "./gazetteer-filter";

const items: GazetteerRow[] = [
  { path: "a.md", title: "Alpha", description: "first note", tags: ["x", "y"], updated_at: "2026-05-03T00:00:00Z", word_count: 100 },
  { path: "b.md", title: "Beta", description: "second", tags: ["x"], updated_at: "2026-05-01T00:00:00Z", word_count: 300 },
  { path: "c.md", title: "Gamma", description: "third note", tags: ["y"], updated_at: "2026-05-02T00:00:00Z", word_count: 200 },
];

describe("filterAndSortRows", () => {
  it("returns all items sorted by updated_at desc when no filters", () => {
    const out = filterAndSortRows(items, { tags: [], query: "", sort: "ts" });
    expect(out.map((r) => r.path)).toEqual(["a.md", "c.md", "b.md"]);
  });

  it("filters by a single tag", () => {
    const out = filterAndSortRows(items, { tags: ["y"], query: "", sort: "ts" });
    expect(out.map((r) => r.path).sort()).toEqual(["a.md", "c.md"]);
  });

  it("AND-filters across multiple tags (row must include ALL selected)", () => {
    const out = filterAndSortRows(items, { tags: ["x", "y"], query: "", sort: "ts" });
    expect(out.map((r) => r.path)).toEqual(["a.md"]);
  });

  it("returns empty when no row has all selected tags", () => {
    const out = filterAndSortRows(items, { tags: ["x", "z"], query: "", sort: "ts" });
    expect(out).toEqual([]);
  });

  it("greps title, path, description and tags (case-insensitive)", () => {
    expect(filterAndSortRows(items, { tags: [], query: "third", sort: "ts" }).map((r) => r.path)).toEqual(["c.md"]);
    expect(filterAndSortRows(items, { tags: [], query: "BETA", sort: "ts" }).map((r) => r.path)).toEqual(["b.md"]);
    expect(filterAndSortRows(items, { tags: [], query: "#y", sort: "ts" }).length).toBe(0); // query is plain text, tags joined without '#'
    expect(filterAndSortRows(items, { tags: [], query: "y", sort: "ts" }).length).toBe(2); // matches tag "y" via joined tags
  });

  it("combines AND tags with grep", () => {
    const out = filterAndSortRows(items, { tags: ["x"], query: "first", sort: "ts" });
    expect(out.map((r) => r.path)).toEqual(["a.md"]);
  });

  it("sorts by words desc, title asc, and id (path) asc", () => {
    expect(filterAndSortRows(items, { tags: [], query: "", sort: "words" }).map((r) => r.path)).toEqual(["b.md", "c.md", "a.md"]);
    expect(filterAndSortRows(items, { tags: [], query: "", sort: "title" }).map((r) => r.title)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(filterAndSortRows(items, { tags: [], query: "", sort: "id" }).map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("does not mutate the input array", () => {
    const snapshot = items.map((r) => r.path);
    filterAndSortRows(items, { tags: [], query: "", sort: "words" });
    expect(items.map((r) => r.path)).toEqual(snapshot);
  });
});
