import { describe, expect, it } from "vitest";
import type { ContentEntry } from "#/api/types";
import { filterAndSortRows } from "./gazetteer-filter";

describe("Gazetteer computed-tag filtering", () => {
  it("matches a page whose effective API tags contain only its computed kind tag", () => {
    const journal = {
      path: "journals/2026-08-11.md",
      title: "2026-08-11",
      description: "",
      kind: "JOURNAL",
      inferred: false,
      project: null,
      links: [],
      tags: ["journal"],
      computed_tags: ["journal"],
      updated_at: "2026-08-11T00:00:00Z",
      word_count: 12,
    } satisfies ContentEntry;

    const filtered = filterAndSortRows([journal], {
      tags: ["journal"],
      query: "",
      sort: "ts",
    });

    expect(filtered.map((row) => row.path)).toEqual(["journals/2026-08-11.md"]);
    expect(filtered[0].tags).toEqual(["journal"]);
  });
});
