import { describe, expect, it } from "vitest";
import {
  CALENDAR_FILTER_URL,
  parseCalendarFilters,
  parseCalendarView,
  SPANS,
  validateCalendarSearch,
} from "#/lib/calendar/search";

describe("calendar search", () => {
  describe("SPANS", () => {
    it("lists the allowed spans per mode", () => {
      expect(SPANS).toEqual({
        month: [1],
        months: [3, 6, 12],
        weeks: [1, 2, 4],
      });
    });
  });

  describe("parseCalendarView", () => {
    it("defaults an empty search to month mode, span 1", () => {
      const view = parseCalendarView({});
      expect(view).toEqual({ mode: "month", span: 1 });
      expect(view.date).toBeUndefined();
      expect(view.day).toBeUndefined();
    });

    it("keeps an allowed months span", () => {
      expect(parseCalendarView({ mode: "months", span: "6" })).toMatchObject({
        mode: "months",
        span: 6,
      });
    });

    it("accepts a numeric span, as TanStack Router parses it", () => {
      expect(parseCalendarView({ mode: "months", span: 12 }).span).toBe(12);
    });

    it("falls back to the default span for a disallowed span", () => {
      expect(parseCalendarView({ mode: "months", span: "5" }).span).toBe(3);
      expect(parseCalendarView({ mode: "months", span: "x" }).span).toBe(3);
    });

    it("defaults weeks mode to span 2", () => {
      expect(parseCalendarView({ mode: "weeks" })).toEqual({
        mode: "weeks",
        span: 2,
      });
    });

    it("forces span 1 in month mode", () => {
      expect(parseCalendarView({ mode: "month", span: "4" }).span).toBe(1);
    });

    it("falls back to month for an unknown mode", () => {
      expect(parseCalendarView({ mode: "bogus" }).mode).toBe("month");
      expect(parseCalendarView({ mode: 3 }).mode).toBe("month");
    });

    it.each([
      "2026-02-30",
      "nope",
      "2026-9-15",
      "2026-13-01",
      "2026-09-15T00:00",
    ])("drops invalid date %s", (date) => {
      expect(parseCalendarView({ date }).date).toBeUndefined();
      expect(parseCalendarView({ day: date }).day).toBeUndefined();
    });

    it("keeps valid date and day keys", () => {
      expect(
        parseCalendarView({ date: "2024-02-29", day: "2026-09-15" }),
      ).toMatchObject({ date: "2024-02-29", day: "2026-09-15" });
    });

    it("drops non-string date values", () => {
      expect(parseCalendarView({ date: 20260915 }).date).toBeUndefined();
    });
  });

  describe("kind filter", () => {
    it("upper-cases kind values from an array", () => {
      expect(
        parseCalendarFilters({ kind: ["journal", "NOTE"] }).facets.kind,
      ).toEqual(["JOURNAL", "NOTE"]);
    });

    it("splits a comma string", () => {
      expect(
        parseCalendarFilters({ kind: "JOURNAL,NOTE" }).facets.kind,
      ).toEqual(["JOURNAL", "NOTE"]);
    });

    it("drops unknown kinds", () => {
      expect(
        parseCalendarFilters({ kind: ["note", "bogus"] }).facets.kind,
      ).toEqual(["NOTE"]);
    });

    it("omits the kind facet when every kind is unknown", () => {
      expect(
        parseCalendarFilters({ kind: "bogus" }).facets.kind,
      ).toBeUndefined();
    });

    it("keeps single tag and project", () => {
      expect(
        parseCalendarFilters({ tag: ["wine", "beer"], project: "clepsydra" })
          .facets,
      ).toEqual({ tag: ["wine"], project: ["clepsydra"] });
    });

    it("declares kind multi (upper-cased), tag and project single", () => {
      expect(CALENDAR_FILTER_URL.fields.map((f) => [f.id, f.kind])).toEqual([
        ["kind", "multi"],
        ["tag", "single"],
        ["project", "single"],
      ]);
      expect(CALENDAR_FILTER_URL.fields[0].normalize?.("note")).toBe("NOTE");
    });
  });

  describe("validateCalendarSearch", () => {
    it("keeps unknown keys", () => {
      expect(validateCalendarSearch({ other: "x" })).toMatchObject({
        other: "x",
      });
    });

    it("writes canonical view fields", () => {
      expect(
        validateCalendarSearch({
          mode: "months",
          span: "5",
          date: "2026-02-30",
          day: "2026-09-15",
        }),
      ).toMatchObject({
        mode: "months",
        span: 3,
        date: undefined,
        day: "2026-09-15",
      });
    });

    it("canonicalises ?mode=weeks&kind=note", () => {
      expect(validateCalendarSearch({ mode: "weeks", kind: "note" })).toEqual({
        mode: "weeks",
        span: 2,
        date: undefined,
        day: undefined,
        kind: ["NOTE"],
        tag: undefined,
        project: undefined,
        q: undefined,
      });
    });

    it("drops unknown kinds from the canonical search", () => {
      expect(
        validateCalendarSearch({ kind: ["bogus", "journal"] }).kind,
      ).toEqual(["JOURNAL"]);
      expect(validateCalendarSearch({ kind: "bogus" }).kind).toBeUndefined();
    });

    it("is idempotent", () => {
      const once = validateCalendarSearch({
        mode: "weeks",
        span: 4,
        kind: "note,journal",
        tag: "wine",
        date: "2026-09-01",
      });
      expect(validateCalendarSearch(once)).toEqual(once);
    });
  });
});
