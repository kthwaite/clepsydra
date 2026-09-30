import { describe, expect, it } from "vitest";
import {
  addMonths,
  dayRange,
  isoWeek,
  mondayOf,
  monthGrid,
  monthGridRange,
  monthsRange,
  rangeForView,
  rangeKeys,
  toOffsetIso,
  weekRows,
} from "#/lib/calendar/dates";

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

describe("calendar dates", () => {
  describe("isoWeek", () => {
    it.each([
      ["2026-12-28", 2026, 53],
      ["2027-01-01", 2026, 53],
      ["2027-01-04", 2027, 1],
      ["2024-12-30", 2025, 1],
      ["2026-09-30", 2026, 40],
    ])("%s → %i-W%i", (key, isoYear, week) => {
      expect(isoWeek(key)).toEqual({ isoYear, week });
    });
  });

  describe("mondayOf", () => {
    it.each([
      ["2026-09-30", "2026-09-28"],
      ["2026-09-28", "2026-09-28"],
      ["2026-10-04", "2026-09-28"],
    ])("%s → %s", (key, monday) => {
      expect(mondayOf(key)).toBe(monday);
    });
  });

  describe("monthGrid", () => {
    it("lays August 2026 out in six Monday-start rows", () => {
      const rows = monthGrid(2026, 7);
      expect(rows).toHaveLength(6);
      expect(rows[0].days[0]).toBe("2026-07-27");
      expect(rows[5].days[0]).toBe("2026-08-31");
      expect(rows.map((r) => r.week)).toEqual([31, 32, 33, 34, 35, 36]);
      for (const row of rows) expect(row.days).toHaveLength(7);
    });

    it("gives February 2027 exactly four rows", () => {
      const rows = monthGrid(2027, 1);
      expect(rows).toHaveLength(4);
      expect(rows[0].days[0]).toBe("2027-02-01");
      expect(rows[3].days[6]).toBe("2027-02-28");
    });

    it("includes the leap day in February 2028", () => {
      const rows = monthGrid(2028, 1);
      expect(rows.flatMap((r) => r.days)).toContain("2028-02-29");
      expect(rows[rows.length - 1].days[6]).toBe("2028-03-05");
    });

    it("shares ISO week 53 across the 2026/2027 year boundary", () => {
      const dec = monthGrid(2026, 11);
      const last = dec[dec.length - 1];
      expect(last.days[0]).toBe("2026-12-28");
      expect(last.days[6]).toBe("2027-01-03");
      expect({ isoYear: last.isoYear, week: last.week }).toEqual({
        isoYear: 2026,
        week: 53,
      });
      const jan = monthGrid(2027, 0);
      expect(jan[0].days).toEqual(last.days);
      expect({ isoYear: jan[0].isoYear, week: jan[0].week }).toEqual({
        isoYear: 2026,
        week: 53,
      });
    });

    it("steps days correctly across DST changes", () => {
      withTz("Europe/London", () => {
        const days = monthGrid(2026, 2).flatMap((r) => r.days);
        expect(days).toContain("2026-03-29");
        expect(days).toContain("2026-03-30");
        expect(new Set(days).size).toBe(days.length);
      });
    });
  });

  describe("addMonths", () => {
    it.each([
      ["2026-01-31", 1, "2026-02-28"],
      ["2028-01-31", 1, "2028-02-29"],
      ["2026-12-15", 1, "2027-01-15"],
      ["2026-03-15", -3, "2025-12-15"],
    ])("%s + %i → %s", (key, n, expected) => {
      expect(addMonths(key, n)).toBe(expected);
    });
  });

  it("monthGridRange spans the March 2026 grid across the DST start", () => {
    withTz("Europe/London", () => {
      const r = monthGridRange(2026, 2);
      expect(toOffsetIso(r.from)).toBe("2026-02-23T00:00:00+00:00");
      expect(toOffsetIso(r.to)).toBe("2026-04-06T00:00:00+01:00");
    });
  });

  it("dayRange spans one local day, even across the DST end", () => {
    withTz("Europe/London", () => {
      const r = dayRange("2026-10-25");
      expect(toOffsetIso(r.from)).toBe("2026-10-25T00:00:00+01:00");
      expect(toOffsetIso(r.to)).toBe("2026-10-26T00:00:00+00:00");
      expect(rangeKeys(r)).toEqual({ first: "2026-10-25", last: "2026-10-25" });
    });
  });

  describe("toOffsetIso", () => {
    it("tracks the London offset across the autumn change", () => {
      withTz("Europe/London", () => {
        expect(toOffsetIso(new Date(2026, 9, 25))).toBe(
          "2026-10-25T00:00:00+01:00",
        );
        expect(toOffsetIso(new Date(2026, 9, 26))).toBe(
          "2026-10-26T00:00:00+00:00",
        );
      });
    });

    it("writes negative offsets", () => {
      withTz("America/New_York", () => {
        expect(toOffsetIso(new Date(2026, 0, 1))).toBe(
          "2026-01-01T00:00:00-05:00",
        );
      });
    });

    it("writes half-hour offsets", () => {
      withTz("Asia/Kolkata", () => {
        expect(toOffsetIso(new Date(2026, 0, 1))).toBe(
          "2026-01-01T00:00:00+05:30",
        );
      });
    });
  });

  it("weekRows starts at the anchor's Monday", () => {
    const rows = weekRows("2026-09-30", 2);
    expect(rows).toHaveLength(2);
    expect(rows[0].days[0]).toBe("2026-09-28");
    expect(rows[1].days[6]).toBe("2026-10-11");
    expect(rows.map((r) => r.week)).toEqual([40, 41]);
  });

  describe("rangeForView", () => {
    it("month mode matches monthGridRange", () => {
      expect(
        rangeForView({ mode: "month", anchor: "2026-08-14", span: 1 }),
      ).toEqual(monthGridRange(2026, 7));
    });

    it("months mode spans first grid start to last grid end", () => {
      const r = rangeForView({ mode: "months", anchor: "2026-11-10", span: 3 });
      expect(r.from).toEqual(monthGridRange(2026, 10).from);
      expect(r.to).toEqual(monthGridRange(2027, 0).to);
      expect(r).toEqual(monthsRange("2026-11-10", 3));
    });

    it("weeks mode covers [mondayOf, +14d)", () => {
      const r = rangeForView({ mode: "weeks", anchor: "2026-09-30", span: 2 });
      expect(r.from).toEqual(new Date(2026, 8, 28));
      expect(r.to).toEqual(new Date(2026, 9, 12));
    });
  });

  it("rangeKeys gives inclusive local keys", () => {
    expect(rangeKeys(monthGridRange(2026, 7))).toEqual({
      first: "2026-07-27",
      last: "2026-09-06",
    });
  });
});
