import { describe, expect, it } from "vitest";
import {
  buildHeatmap,
  deriveInventory,
  dayOfYear,
  julianDay,
  sortRecents,
  type RecentItem,
} from "./atrium-data";

describe("dayOfYear / julianDay", () => {
  it("computes day-of-year (1-based)", () => {
    expect(dayOfYear(new Date(Date.UTC(2026, 0, 1)))).toBe(1);
    expect(dayOfYear(new Date(Date.UTC(2026, 4, 2)))).toBe(122);
  });
  it("computes the Julian Day Number", () => {
    expect(julianDay(new Date(Date.UTC(2026, 4, 2)))).toBe(2461163);
  });
});

describe("buildHeatmap", () => {
  const now = new Date("2026-05-02T12:00:00Z");

  it("returns 26 week-columns of 7 days each", () => {
    const h = buildHeatmap([], now);
    expect(h.weeks).toHaveLength(27); // 26 full weeks + the partial current week
    for (const w of h.weeks) expect(w).toHaveLength(7);
    expect(h.total).toBe(0);
    expect(h.currentStreak).toBe(0);
    expect(h.longestStreak).toBe(0);
  });

  it("counts entries by UTC day and totals them", () => {
    const items = [
      { updated_at: "2026-05-02T01:00:00Z" },
      { updated_at: "2026-05-02T09:00:00Z" },
      { updated_at: "2026-05-01T09:00:00Z" },
      { created_at: "2026-04-30T09:00:00Z", updated_at: null },
    ];
    const h = buildHeatmap(items, now);
    expect(h.total).toBe(4);
    // 3 consecutive days ending today => current streak 3
    expect(h.currentStreak).toBe(3);
    expect(h.longestStreak).toBeGreaterThanOrEqual(3);
  });

  it("maps counts to six levels (0..5)", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, () => ({ updated_at: "2026-05-02T01:00:00Z" }));
    expect(buildHeatmap(mk(0), now).maxLevelToday).toBe(0);
    expect(buildHeatmap(mk(1), now).maxLevelToday).toBe(1);
    expect(buildHeatmap(mk(3), now).maxLevelToday).toBe(2);
    expect(buildHeatmap(mk(6), now).maxLevelToday).toBe(3);
    expect(buildHeatmap(mk(10), now).maxLevelToday).toBe(4);
    expect(buildHeatmap(mk(20), now).maxLevelToday).toBe(5);
  });

  it("clamps currentStreak to the heatmap window (never exceeds longestStreak)", () => {
    const items = Array.from({ length: 220 }, (_, i) => {
      const d = new Date(now.getTime() - i * 86_400_000);
      return { updated_at: d.toISOString() };
    });
    const h = buildHeatmap(items, now);
    expect(h.currentStreak).toBeLessThanOrEqual(h.longestStreak);
    expect(h.currentStreak).toBeLessThanOrEqual(h.weeks.length * 7);
  });
});

describe("deriveInventory", () => {
  const now = new Date("2026-05-02T12:00:00Z");
  const stats = {
    pages: 100,
    links_total: 343,
    links_unresolved: 12,
    links_resolved: 331,
    tags: 20,
    attachments: 5,
    last_indexed_at: null,
    orphan_pages: 4,
    isolated_pages: 1,
  };
  const tags = [
    { tag: "epistemics", count: 5 },
    { tag: "hapax-one", count: 1 },
    { tag: "hapax-two", count: 1 },
  ];
  const items = [
    { created_at: "2026-05-02T01:00:00Z", updated_at: "2026-05-02T02:00:00Z", tags: ["x"] },
    { created_at: "2026-04-29T01:00:00Z", updated_at: "2026-05-02T05:00:00Z", tags: [] },
    { created_at: "2026-03-01T01:00:00Z", updated_at: "2026-03-01T01:00:00Z", tags: ["y"] },
  ];

  it("derives corpus cells with real subs", () => {
    const cells = deriveInventory(stats, tags, items, now);
    const byLabel = Object.fromEntries(cells.map((c) => [c.label, c]));
    expect(byLabel.Notes.value).toBe("100");
    expect(byLabel.Links.value).toBe("343");
    expect(byLabel.Links.sub).toBe("density 3.43");
    expect(byLabel.Tags.sub).toBe("hapax 2");
    expect(byLabel.Unresolved.value).toBe("12");
    expect(byLabel.Unresolved.tone).toBe("warn");
    expect(byLabel.Orphans.value).toBe("4");
    expect(byLabel.Isolated.value).toBe("1");
    expect(byLabel.Orphans.tone).toBeUndefined(); // informational, not a warning
    expect(byLabel.Isolated.tone).toBeUndefined();
    expect(byLabel.Orphans.sub).toBe("no backlinks");
    expect(byLabel.Isolated.sub).toBe("no links in or out");
  });

  it("derives today/7d cells from item timestamps", () => {
    const cells = deriveInventory(stats, tags, items, now);
    const byLabel = Object.fromEntries(cells.map((c) => [c.label, c]));
    expect(byLabel["Captures · today"].value).toBe("1"); // created 05-02
    expect(byLabel["Edited · today"].value).toBe("2"); // updated 05-02 x2
    expect(byLabel["New · 7d"].value).toBe("2"); // created 05-02 and 04-29
    expect(byLabel.Unfiled.value).toBe("1"); // one item with no tags
  });

  it("omits corpus cells when stats are unavailable", () => {
    const cells = deriveInventory(undefined, undefined, items, now);
    const labels = cells.map((c) => c.label);
    expect(labels).not.toContain("Notes");
    expect(labels).toContain("Captures · today");
  });
});

describe("sortRecents", () => {
  const items: RecentItem[] = [
    { path: "a.md", title: "A", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-03T00:00:00Z", tags: [] },
    { path: "b.md", title: "B", created_at: "2026-05-02T00:00:00Z", updated_at: "2026-05-01T00:00:00Z", tags: [] },
  ];
  it("sorts by updated_at desc for 'edited'", () => {
    expect(sortRecents(items, "edited").map((i) => i.path)).toEqual(["a.md", "b.md"]);
  });
  it("sorts by created_at desc for 'created'", () => {
    expect(sortRecents(items, "created").map((i) => i.path)).toEqual(["b.md", "a.md"]);
  });
});
