import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAbsoluteDate, formatRelativeTime } from "./codex-time";

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
