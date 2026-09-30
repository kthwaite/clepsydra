import { describe, expect, it } from "vitest";
import {
  bucketEntries,
  type CalendarEntryLike,
  dayKinds,
  groupByKind,
  JOURNAL_KINDS,
  placementKey,
} from "#/lib/calendar/bucket";
import { localDateKey } from "#/lib/time";

function withTz(tz: string, run: () => void) {
  const previousTz = process.env.TZ;
  process.env.TZ = tz;
  try {
    run();
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
}

const e = (over: Partial<CalendarEntryLike>): CalendarEntryLike => ({
  path: over.path ?? `${over.title ?? "x"}.md`,
  title: null,
  kind: "NOTE",
  created_at: null,
  journal_date: null,
  ...over,
});

describe("calendar bucketing", () => {
  it("JOURNAL_KINDS holds the two journal kinds", () => {
    expect([...JOURNAL_KINDS].sort()).toEqual(["AI_JOURNAL", "JOURNAL"]);
  });

  describe("placementKey", () => {
    it("places a journal on its journal_date", () => {
      expect(
        placementKey(
          e({
            kind: "JOURNAL",
            journal_date: "2026-09-15",
            created_at: "2026-09-16T08:00:00+00:00",
          }),
        ),
      ).toBe("2026-09-15");
    });

    it("falls back to created_at for a journal without journal_date", () => {
      const created = "2026-09-16T08:00:00+00:00";
      expect(placementKey(e({ kind: "JOURNAL", created_at: created }))).toBe(
        localDateKey(new Date(created)),
      );
    });

    it("ignores journal_date on a non-journal kind", () => {
      const created = "2026-09-16T08:00:00+00:00";
      expect(
        placementKey(
          e({ kind: "NOTE", journal_date: "2026-09-15", created_at: created }),
        ),
      ).toBe(localDateKey(new Date(created)));
    });

    it("returns null without created_at", () => {
      expect(placementKey(e({ kind: "NOTE", created_at: null }))).toBeNull();
    });
  });

  describe("local-date conversion", () => {
    const at = (created_at: string) => placementKey(e({ created_at }));

    it("follows London across the autumn change", () => {
      withTz("Europe/London", () => {
        expect(at("2026-10-24T23:30:00+00:00")).toBe("2026-10-25");
        expect(at("2026-10-25T23:30:00+00:00")).toBe("2026-10-25");
      });
    });

    it("moves back a day in New York", () => {
      withTz("America/New_York", () => {
        expect(at("2026-09-16T02:00:00+00:00")).toBe("2026-09-15");
      });
    });

    it("moves forward a day in Kiritimati", () => {
      withTz("Pacific/Kiritimati", () => {
        expect(at("2026-09-15T11:00:00+00:00")).toBe("2026-09-16");
      });
    });

    it("handles the year boundary", () => {
      withTz("Europe/London", () => {
        expect(at("2026-12-31T23:30:00+00:00")).toBe("2026-12-31");
      });
      withTz("America/Los_Angeles", () => {
        expect(at("2027-01-01T05:00:00+00:00")).toBe("2026-12-31");
      });
    });
  });

  describe("bucketEntries", () => {
    const range = { first: "2026-09-01", last: "2026-09-30" };

    it("drops a journal dated past the range (server pad)", () => {
      const out = bucketEntries(
        [e({ kind: "JOURNAL", journal_date: "2026-10-01" })],
        range,
      );
      expect(out.size).toBe(0);
    });

    it("drops entries before the range", () => {
      const out = bucketEntries(
        [e({ kind: "JOURNAL", journal_date: "2026-08-31" })],
        range,
      );
      expect(out.size).toBe(0);
    });

    it("removes hidden kinds", () => {
      const day = "2026-09-10T12:00:00+00:00";
      const out = bucketEntries(
        [
          e({ kind: "RECIPE", path: "r.md", created_at: day }),
          e({ kind: "NOTE", path: "n.md", created_at: day }),
        ],
        range,
        new Set(["RECIPE"]),
      );
      expect([...out.values()].flat().map((x) => x.path)).toEqual(["n.md"]);
    });

    it("sorts a day journal-first, then title, then path; no empty keys", () => {
      withTz("UTC", () => {
        const day = "2026-09-10T12:00:00+00:00";
        const entries = [
          e({ title: "zeta", path: "z.md", created_at: day }),
          e({ title: "Alpha", path: "b.md", created_at: day }),
          e({ title: "Alpha", path: "a.md", created_at: day }),
          e({ kind: "JOURNAL", journal_date: "2026-09-10", path: "j.md" }),
        ];
        const out = bucketEntries(entries, range);
        expect([...out.keys()]).toEqual(["2026-09-10"]);
        expect(out.get("2026-09-10")?.map((x) => x.path)).toEqual([
          "j.md",
          "a.md",
          "b.md",
          "z.md",
        ]);
      });
    });

    it("drops entries with no placement", () => {
      expect(bucketEntries([e({})], range).size).toBe(0);
    });
  });

  describe("dayKinds", () => {
    it("caps distinct kinds, journals first, duplicates collapsed", () => {
      const kinds = dayKinds(
        [
          e({ kind: "RECIPE" }),
          e({ kind: "NOTE" }),
          e({ kind: "NOTE" }),
          e({ kind: "BOOK" }),
          e({ kind: "PROJECT" }),
          e({ kind: "AI_JOURNAL" }),
          e({ kind: "JOURNAL" }),
        ],
        4,
      );
      expect(kinds).toEqual(["JOURNAL", "AI_JOURNAL", "NOTE", "PROJECT"]);
    });

    it("defaults max to 4", () => {
      const kinds = dayKinds(
        (["NOTE", "BOOK", "CODE", "TASK", "MEETING", "RECIPE"] as const).map(
          (kind) => e({ kind }),
        ),
      );
      expect(kinds).toHaveLength(4);
    });
  });

  it("groupByKind follows dayKinds order and keeps sorted order", () => {
    const groups = groupByKind([
      e({ kind: "NOTE", title: "a", path: "a.md" }),
      e({ kind: "BOOK", title: "b", path: "b.md" }),
      e({ kind: "NOTE", title: "c", path: "c.md" }),
      e({ kind: "JOURNAL", path: "j.md" }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["JOURNAL", "NOTE", "BOOK"]);
    expect(groups[1].entries.map((x) => x.path)).toEqual(["a.md", "c.md"]);
  });
});
