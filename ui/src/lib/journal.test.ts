import { describe, expect, it } from "vitest";
import {
  fastiRows,
  journalDateFromPath,
  journalDayLabel,
  journalPathForDate,
  nearestEntry,
  relativeDays,
  shortDate,
} from "#/lib/journal";

describe("journalPathForDate / journalDateFromPath", () => {
  it("round-trips a date key", () => {
    expect(journalPathForDate("2026-08-07")).toBe("journals/2026-08-07.md");
    expect(journalDateFromPath("journals/2026-08-07.md")).toBe("2026-08-07");
  });

  it("rejects non-journal paths", () => {
    expect(journalDateFromPath("notes/2026-08-07.md")).toBeNull();
    expect(journalDateFromPath("journals/notes.md")).toBeNull();
    expect(journalDateFromPath("journals/2026-08-07.md.bak")).toBeNull();
  });
});

describe("journalDayLabel", () => {
  it("formats a long day label with the year", () => {
    const label = journalDayLabel("journals/2026-08-07.md", "2026-08-07");
    expect(label).toContain("2026");
    expect(label).not.toBe("2026-08-07");
  });

  it("falls back to a date-shaped title when the path has none", () => {
    const label = journalDayLabel("notes/misfiled.md", "2026-08-07");
    expect(label).toContain("2026");
    expect(label).not.toBe("2026-08-07");
  });

  it("falls back to the raw title when nothing parses", () => {
    expect(journalDayLabel("notes/misfiled.md", "Not A Date")).toBe(
      "Not A Date",
    );
  });
});

describe("nearestEntry", () => {
  const keys = ["2026-08-01", "2026-08-03", "2026-08-07"];

  it("skips gaps to the nearest older entry", () => {
    expect(nearestEntry(keys, "2026-08-07", -1)).toBe("2026-08-03");
    expect(nearestEntry(keys, "2026-08-02", -1)).toBe("2026-08-01");
  });

  it("skips gaps to the nearest newer entry", () => {
    expect(nearestEntry(keys, "2026-08-01", 1)).toBe("2026-08-03");
    expect(nearestEntry(keys, "2026-08-04", 1)).toBe("2026-08-07");
  });

  it("returns null at the edges", () => {
    expect(nearestEntry(keys, "2026-08-01", -1)).toBeNull();
    expect(nearestEntry(keys, "2026-08-07", 1)).toBeNull();
    expect(nearestEntry([], "2026-08-07", -1)).toBeNull();
  });
});

describe("fastiRows", () => {
  it("synthesizes calendar days newest-first with null paths for gaps", () => {
    const entries = [
      { path: "journals/2026-08-07.md", journal_date: "2026-08-07" },
      { path: "journals/2026-08-05.md", journal_date: "2026-08-05" },
    ];
    const rows = fastiRows(entries, "2026-08-07", 4);
    expect(rows).toEqual([
      { dateKey: "2026-08-07", path: "journals/2026-08-07.md" },
      { dateKey: "2026-08-06", path: null },
      { dateKey: "2026-08-05", path: "journals/2026-08-05.md" },
      { dateKey: "2026-08-04", path: null },
    ]);
  });
});

describe("shortDate / relativeDays", () => {
  it("renders d/m", () => {
    expect(shortDate("2026-08-07")).toBe("7/8");
  });

  it("renders relative day offsets", () => {
    expect(relativeDays("2026-08-07", "2026-08-07")).toBe("today");
    expect(relativeDays("2026-08-05", "2026-08-07")).toBe("2d");
    expect(relativeDays("2026-08-08", "2026-08-07")).toBe("—");
  });
});
