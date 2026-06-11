/**
 * timeline-math.test.ts
 *
 * Pure unit tests for timeline-math helpers.  No React/DOM needed.
 */

import { describe, expect, it } from "vitest";
import type { BoardCycle, BoardTask } from "#/api/board";
import {
  parseDay,
  pct,
  type TLWindow,
  taskRange,
  windowOf,
} from "../timeline-math";

// ── helpers ───────────────────────────────────────────────────────────────────

const DAY_MS = 864e5;

function cycle(
  start: string | null,
  end: string | null,
  state = "PLANNED",
): BoardCycle {
  return {
    id: "test-id",
    code: "C-TEST",
    label: "Test",
    state,
    path: "tasks/c-test.md",
    start,
    end,
    goal: null,
  };
}

function task(due: string | null, start?: string | null): BoardTask {
  return {
    id: "t-test",
    code: "TSK-0001",
    title: "Test Task",
    status: "FIELD",
    priority: "P1",
    project: "alpha",
    cycle: null,
    tags: [],
    checks: [],
    path: "tasks/t-test.md",
    updated_at: "2026-01-01T00:00:00Z",
    due: due ?? undefined,
    start: start ?? undefined,
  };
}

// ── parseDay ──────────────────────────────────────────────────────────────────

describe("parseDay", () => {
  it("parses a valid ISO date to local-midnight ms", () => {
    const ms = parseDay("2026-06-15");
    expect(ms).not.toBeNull();
    const d = new Date(ms!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5); // 0-indexed June
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it("returns null for null input", () => {
    expect(parseDay(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseDay(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseDay("")).toBeNull();
  });

  it("returns null for MM.DD format (ISO only — prototype deviation)", () => {
    expect(parseDay("06.15")).toBeNull();
  });

  it("returns null for MM/DD/YYYY format", () => {
    expect(parseDay("06/15/2026")).toBeNull();
  });

  it("returns null for a datetime string (not bare date)", () => {
    expect(parseDay("2026-06-15T00:00:00")).toBeNull();
  });

  it("returns null for nonsense string", () => {
    expect(parseDay("not-a-date")).toBeNull();
  });

  it("parses two distinct dates to different ms values", () => {
    const d1 = parseDay("2026-06-01");
    const d2 = parseDay("2026-06-08");
    expect(d1).not.toBeNull();
    expect(d2).not.toBeNull();
    expect(d2! - d1!).toBe(7 * DAY_MS);
  });
});

// ── windowOf ──────────────────────────────────────────────────────────────────

describe("windowOf", () => {
  it("returns null for empty cycles array", () => {
    expect(windowOf([])).toBeNull();
  });

  it("returns null when no cycle has a valid start or end date", () => {
    expect(windowOf([cycle(null, null)])).toBeNull();
  });

  it("returns window ±2 days around a single dated cycle", () => {
    const c = cycle("2026-05-26", "2026-06-08");
    const win = windowOf([c]);
    expect(win).not.toBeNull();
    const expectedStart = parseDay("2026-05-26")! - 2 * DAY_MS;
    const expectedEnd = parseDay("2026-06-08")! + 2 * DAY_MS;
    expect(win!.start).toBe(expectedStart);
    expect(win!.end).toBe(expectedEnd);
  });

  it("uses min(start) and max(end) across multiple cycles", () => {
    const cycles: BoardCycle[] = [
      cycle("2026-05-26", "2026-06-08"),
      cycle("2026-06-09", "2026-06-22"),
    ];
    const win = windowOf(cycles);
    expect(win).not.toBeNull();
    const expectedStart = parseDay("2026-05-26")! - 2 * DAY_MS;
    const expectedEnd = parseDay("2026-06-22")! + 2 * DAY_MS;
    expect(win!.start).toBe(expectedStart);
    expect(win!.end).toBe(expectedEnd);
  });

  it("handles a cycle with only a start date", () => {
    const win = windowOf([cycle("2026-06-01", null)]);
    expect(win).not.toBeNull();
    // When only start is available, end falls back to start + 2d
    const s = parseDay("2026-06-01")!;
    expect(win!.start).toBe(s - 2 * DAY_MS);
    expect(win!.end).toBe(s + 2 * DAY_MS);
  });

  it("handles a cycle with only an end date", () => {
    const win = windowOf([cycle(null, "2026-06-22")]);
    expect(win).not.toBeNull();
    const e = parseDay("2026-06-22")!;
    expect(win!.start).toBe(e - 2 * DAY_MS);
    expect(win!.end).toBe(e + 2 * DAY_MS);
  });

  it("ignores cycles whose start/end are null when others have dates", () => {
    const cycles: BoardCycle[] = [
      cycle(null, null),
      cycle("2026-06-01", "2026-06-14"),
    ];
    const win = windowOf(cycles);
    expect(win).not.toBeNull();
    expect(win!.start).toBe(parseDay("2026-06-01")! - 2 * DAY_MS);
    expect(win!.end).toBe(parseDay("2026-06-14")! + 2 * DAY_MS);
  });
});

// ── pct ───────────────────────────────────────────────────────────────────────

describe("pct", () => {
  const win: TLWindow = {
    start: parseDay("2026-05-24")!, // -2d from first cycle start
    end: parseDay("2026-06-10")!, // +2d from last cycle end
  };

  it("returns 0 for ms at the window start", () => {
    expect(pct(win.start, win)).toBe(0);
  });

  it("returns 100 for ms at the window end", () => {
    expect(pct(win.end, win)).toBe(100);
  });

  it("returns ~50 for ms at the midpoint", () => {
    const mid = win.start + (win.end - win.start) / 2;
    const p = pct(mid, win);
    expect(p).toBeCloseTo(50, 1);
  });

  it("clamps below 0 to 0", () => {
    expect(pct(win.start - DAY_MS, win)).toBe(0);
  });

  it("clamps above 100 to 100", () => {
    expect(pct(win.end + DAY_MS, win)).toBe(100);
  });

  it("degenerate window (start === end) returns 0 without throwing", () => {
    const degen: TLWindow = { start: 1000, end: 1000 };
    expect(() => pct(1000, degen)).not.toThrow();
    expect(pct(1000, degen)).toBe(0);
  });
});

// ── taskRange ─────────────────────────────────────────────────────────────────

describe("taskRange", () => {
  it("returns null when task has no due date", () => {
    expect(taskRange(task(null))).toBeNull();
  });

  it("returns null when task.due is undefined", () => {
    const t = task(null);
    expect(taskRange({ ...t, due: undefined })).toBeNull();
  });

  it("uses due as end and due-2d as start when no explicit start", () => {
    const t = task("2026-06-10");
    const range = taskRange(t);
    expect(range).not.toBeNull();
    const e = parseDay("2026-06-10")!;
    expect(range!.e).toBe(e);
    expect(range!.s).toBe(e - 2 * DAY_MS);
  });

  it("uses explicit start when set", () => {
    const t = task("2026-06-10", "2026-06-01");
    const range = taskRange(t);
    expect(range).not.toBeNull();
    expect(range!.s).toBe(parseDay("2026-06-01")!);
    expect(range!.e).toBe(parseDay("2026-06-10")!);
  });

  it("falls back to due-2d when start is an invalid/non-ISO string", () => {
    const t = { ...task("2026-06-10"), start: "06.01" };
    const range = taskRange(t);
    expect(range).not.toBeNull();
    const e = parseDay("2026-06-10")!;
    expect(range!.s).toBe(e - 2 * DAY_MS);
  });

  it("start can equal due (zero-width bar, handled by min-width in component)", () => {
    const t = task("2026-06-10", "2026-06-10");
    const range = taskRange(t);
    expect(range).not.toBeNull();
    expect(range!.s).toBe(range!.e);
  });
});
