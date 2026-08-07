import { describe, expect, it } from "vitest";
import {
  aphorismForDay,
  buildHeatmap,
  daystampLabel,
  deriveInventory,
  formatBclDate,
  formatBclDuration,
  formatDotDate,
  greeting,
  type Heatmap,
  type RecentItem,
  sortRecents,
} from "./atrium-data";

describe("daystart presentation", () => {
  it("formats the diegetic dot-date and daystamp", () => {
    const d = new Date(2026, 7, 7); // a Friday
    expect(formatDotDate(d)).toBe("2026.08.07");
    expect(daystampLabel(d)).toBe("2026.08.07 (FRI)");
  });

  it("greets by local time of day", () => {
    expect(greeting(new Date(2026, 0, 1, 3))).toBe("Still awake?!");
    expect(greeting(new Date(2026, 0, 1, 9))).toBe("Good morning");
    expect(greeting(new Date(2026, 0, 1, 14))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 0, 1, 20))).toBe("Good evening");
    expect(greeting(new Date(2026, 0, 1, 23))).toBe("Good night");
  });

  it("rotates the aphorism by day and stays stable within a day", () => {
    const a = aphorismForDay(new Date(2026, 7, 7, 1));
    const b = aphorismForDay(new Date(2026, 7, 7, 23));
    expect(a).toEqual(b);
    expect(a.text).toBeTruthy();
    expect(a.who).toBeTruthy();
  });

  it("formats BCL countdowns with sign and locale separators", () => {
    expect(formatBclDuration(90_000)).toBe("1d · 1h");
    expect(formatBclDuration(-90_000)).toBe("+1d · 1h");
    expect(formatBclDuration(1_234 * 86_400)).toBe("1,234d · 0h");
  });

  it("formats BCL dates and echoes malformed input", () => {
    expect(formatBclDate("2054-03-15")).toMatch(/2054/);
    expect(formatBclDate("not-a-date")).toBe("not-a-date");
  });
});

describe("buildHeatmap", () => {
  const now = new Date("2026-05-02T12:00:00Z");

  it("returns 26 week-columns of 7 days each", () => {
    const h = buildHeatmap([], now);
    expect(h.weeks).toHaveLength(27); // 26 full weeks + the partial current week
    for (const w of h.weeks) {
      expect(w).toHaveLength(7);
      for (const day of w) expect(day.level).toBe(0);
    }
    expect(h.total).toBe(0);
    expect(h.currentStreak).toBe(0);
    expect(h.longestStreak).toBe(0);
  });

  function heatDay(heat: Heatmap, date: string) {
    const day = heat.weeks.flat().find((candidate) => candidate.date === date);
    expect(day).toBeDefined();
    return day!;
  }

  it("attaches UTC counts and newest-first page metadata to each day", () => {
    const heat = buildHeatmap(
      [
        {
          path: "older.md",
          title: "Older",
          created_at: "2026-05-01T23:30:00Z",
          updated_at: "2026-05-02T01:00:00Z",
        },
        {
          path: "newer.md",
          title: "Newer",
          created_at: "2026-04-01T00:00:00Z",
          updated_at: "2026-05-02T09:00:00Z",
        },
      ],
      now,
    );

    expect(heatDay(heat, "2026-05-02")).toMatchObject({
      date: "2026-05-02",
      isFuture: false,
      count: 2,
      level: 1,
      pages: [
        { path: "newer.md", title: "Newer", activityAt: "2026-05-02T09:00:00Z" },
        { path: "older.md", title: "Older", activityAt: "2026-05-02T01:00:00Z" },
      ],
    });
    expect(heatDay(heat, "2026-05-01").count).toBe(0);
  });

  it("counts pathless items without rendering them as pages", () => {
    const heat = buildHeatmap([{ updated_at: "2026-05-02T12:00:00Z" }], now);
    expect(heatDay(heat, "2026-05-02")).toMatchObject({ count: 1, pages: [] });
  });

  it("marks dates after today as future placeholders", () => {
    const heat = buildHeatmap([], now);
    expect(heat.weeks.flat().filter((day) => day.isFuture).every((day) => day.count === 0)).toBe(true);
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
    {
      created_at: "2026-05-02T01:00:00Z",
      updated_at: "2026-05-02T02:00:00Z",
      tags: ["x"],
    },
    {
      created_at: "2026-04-29T01:00:00Z",
      updated_at: "2026-05-02T05:00:00Z",
      tags: [],
    },
    {
      created_at: "2026-03-01T01:00:00Z",
      updated_at: "2026-03-01T01:00:00Z",
      tags: ["y"],
    },
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
    {
      path: "a.md",
      title: "A",
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-03T00:00:00Z",
      tags: [],
    },
    {
      path: "b.md",
      title: "B",
      created_at: "2026-05-02T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
      tags: [],
    },
  ];
  it("sorts by updated_at desc for 'edited'", () => {
    expect(sortRecents(items, "edited").map((i) => i.path)).toEqual([
      "a.md",
      "b.md",
    ]);
  });
  it("sorts by created_at desc for 'created'", () => {
    expect(sortRecents(items, "created").map((i) => i.path)).toEqual([
      "b.md",
      "a.md",
    ]);
  });
});
