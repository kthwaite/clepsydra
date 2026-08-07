import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dayOfYear,
  formatAbsoluteDate,
  formatClock,
  formatDurationHM,
  formatRelativeTime,
  formatTimeHM,
  isLeapYear,
  isoAddDays,
  julianDay,
  localDateKey,
  pad2,
  parseLocalDate,
} from "./time";

describe("pad2", () => {
  it("pads single digits and leaves two-digit values alone", () => {
    expect(pad2(0)).toBe("00");
    expect(pad2(7)).toBe("07");
    expect(pad2(42)).toBe("42");
  });
});

describe("localDateKey / parseLocalDate", () => {
  it("formats a local date as YYYY-MM-DD", () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
  it("parses to local midnight and round-trips", () => {
    const d = parseLocalDate("2026-08-07");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(7);
    expect(d.getHours()).toBe(0);
    expect(localDateKey(d)).toBe("2026-08-07");
  });
});

describe("isoAddDays", () => {
  it("adds and subtracts days across month and year boundaries", () => {
    expect(isoAddDays("2026-08-07", 1)).toBe("2026-08-08");
    expect(isoAddDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(isoAddDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isoAddDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("dayOfYear / isLeapYear / julianDay", () => {
  it("computes day-of-year (1-based) from local calendar dates", () => {
    expect(dayOfYear(new Date(2026, 0, 1))).toBe(1);
    expect(dayOfYear(new Date(2026, 4, 2))).toBe(122);
    expect(dayOfYear(new Date(2026, 11, 31))).toBe(365);
    expect(dayOfYear(new Date(2024, 11, 31))).toBe(366); // leap year
  });
  it("identifies Gregorian leap years", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });
  it("computes the Julian Day Number", () => {
    expect(julianDay(new Date(Date.UTC(2026, 4, 2)))).toBe(2461163);
  });
});

describe("formatClock / formatTimeHM", () => {
  it("formats a local HH:MM:SS clock", () => {
    expect(formatClock(new Date(2026, 0, 1, 9, 5, 3))).toBe("09:05:03");
  });
  it("formats a UTC clock when asked", () => {
    expect(formatClock(new Date(Date.UTC(2026, 0, 1, 23, 59, 0)), true)).toBe(
      "23:59:00",
    );
  });
  it("formats local HH:MM", () => {
    expect(formatTimeHM(new Date(2026, 0, 1, 6, 4))).toBe("06:04");
  });
});

describe("formatDurationHM", () => {
  it("formats seconds as Xh YYm", () => {
    expect(formatDurationHM(0)).toBe("0h 00m");
    expect(formatDurationHM(59)).toBe("0h 00m");
    expect(formatDurationHM(3660)).toBe("1h 01m");
    expect(formatDurationHM(26 * 3600 + 5 * 60)).toBe("26h 05m");
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns em-dash for null/undefined/empty", () => {
    expect(formatRelativeTime(null)).toBe("—");
    expect(formatRelativeTime(undefined)).toBe("—");
    expect(formatRelativeTime("")).toBe("—");
  });

  it("returns em-dash for unparseable strings", () => {
    expect(formatRelativeTime("not a date")).toBe("—");
  });

  it("returns 'just now' for sub-minute deltas", () => {
    expect(formatRelativeTime("2026-04-28T11:59:30Z")).toBe("just now");
  });

  it("returns minutes for sub-hour deltas", () => {
    expect(formatRelativeTime("2026-04-28T11:55:00Z")).toBe("5m ago");
    expect(formatRelativeTime("2026-04-28T11:01:00Z")).toBe("59m ago");
  });

  it("returns hours for sub-day deltas", () => {
    expect(formatRelativeTime("2026-04-28T09:00:00Z")).toBe("3h ago");
    expect(formatRelativeTime("2026-04-27T13:00:00Z")).toBe("23h ago");
  });

  it("returns days for sub-week deltas", () => {
    expect(formatRelativeTime("2026-04-25T12:00:00Z")).toBe("3d ago");
    expect(formatRelativeTime("2026-04-22T12:00:00Z")).toBe("6d ago");
  });

  it("returns weeks for sub-month deltas", () => {
    expect(formatRelativeTime("2026-04-21T12:00:00Z")).toBe("1w ago");
    expect(formatRelativeTime("2026-04-07T12:00:00Z")).toBe("3w ago");
  });

  it("returns months for older dates", () => {
    expect(formatRelativeTime("2026-03-01T12:00:00Z")).toBe("1mo ago");
    expect(formatRelativeTime("2025-04-28T12:00:00Z")).toBe("12mo ago");
  });
});

describe("formatAbsoluteDate", () => {
  it("returns em-dash for null/undefined/empty", () => {
    expect(formatAbsoluteDate(null)).toBe("—");
    expect(formatAbsoluteDate(undefined)).toBe("—");
    expect(formatAbsoluteDate("")).toBe("—");
  });

  it("returns em-dash for unparseable strings", () => {
    expect(formatAbsoluteDate("not a date")).toBe("—");
  });

  it("formats valid ISO strings with day, full month name, and year", () => {
    // toLocaleDateString output is locale-dependent; assert structurally.
    const out = formatAbsoluteDate("2026-04-28T12:00:00Z");
    expect(out).toMatch(/2026/);
    // Full month name should be "April" (not "Apr") in en-* locales; allow either by checking it's not numeric.
    expect(out).not.toMatch(/^\d+\/\d+\/\d+$/);
  });
});
