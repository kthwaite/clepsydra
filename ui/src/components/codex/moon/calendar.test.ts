import { describe, expect, it } from "vitest";
import {
  dayPhaseName,
  formatEventDate,
  formatMonthTitle,
  monthGrid,
  phaseGlyphPath,
  shiftMonth,
} from "./calendar";
import { monthPhases } from "./moon";

describe("monthGrid", () => {
  it("starts October 2026 on Thursday after three Monday-first blanks", () => {
    const cells = monthGrid(2026, 9);
    expect(cells.slice(0, 4)).toEqual([null, null, null, 1]);
    expect(cells.filter((c) => c !== null)).toHaveLength(31);
  });

  it("has no blanks when the 1st is a Monday", () => {
    expect(monthGrid(2026, 5)[0]).toBe(1); // 1 June 2026 is a Monday
  });
});

describe("month helpers", () => {
  it("shifts across year boundaries", () => {
    expect(shiftMonth({ year: 2026, monthIndex0: 11 }, 1)).toEqual({
      year: 2027,
      monthIndex0: 0,
    });
    expect(shiftMonth({ year: 2026, monthIndex0: 0 }, -1)).toEqual({
      year: 2025,
      monthIndex0: 11,
    });
  });

  it("titles and formats event dates en-GB", () => {
    expect(formatMonthTitle({ year: 2026, monthIndex0: 9 })).toBe(
      "October 2026",
    );
    expect(formatEventDate(new Date(2026, 9, 10, 16))).toBe("Sat 10 Oct");
  });
});

describe("dayPhaseName", () => {
  it("names event days by the event and others by phase", () => {
    const { days, events } = monthPhases(2026, 9);
    expect(dayPhaseName(days[9], events)).toBe("New moon");
    expect(dayPhaseName(days[25], events)).toBe("Full moon");
    expect(dayPhaseName(days[13], events)).toBe("Waxing crescent");
  });
});

describe("phaseGlyphPath", () => {
  it("draws nothing at new moon and a full circle at full", () => {
    expect(phaseGlyphPath(0, true, 10)).toBeNull();
    expect(phaseGlyphPath(1, false, 10)).toBe(
      "M 10 0 A 10 10 0 0 1 10 20 A 10 10 0 0 1 10 0 Z",
    );
  });

  it("lights the right half at first quarter with a straight terminator", () => {
    expect(phaseGlyphPath(0.5, true, 10)).toBe(
      "M 10 0 A 10 10 0 0 1 10 20 A 0 10 0 0 0 10 0 Z",
    );
  });

  it("bulges the terminator toward the lit side for a crescent", () => {
    expect(phaseGlyphPath(0.25, true, 10)).toBe(
      "M 10 0 A 10 10 0 0 1 10 20 A 5 10 0 0 0 10 0 Z",
    );
    expect(phaseGlyphPath(0.25, false, 10)).toBe(
      "M 10 0 A 10 10 0 0 0 10 20 A 5 10 0 0 1 10 0 Z",
    );
  });

  it("bulges the terminator away from the lit side for a gibbous", () => {
    expect(phaseGlyphPath(0.75, true, 10)).toBe(
      "M 10 0 A 10 10 0 0 1 10 20 A 5 10 0 0 1 10 0 Z",
    );
    expect(phaseGlyphPath(0.75, false, 10)).toBe(
      "M 10 0 A 10 10 0 0 0 10 20 A 5 10 0 0 0 10 0 Z",
    );
  });
});
