import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  dayLabel,
  dragTo,
  formatMoonInstant,
  HOUR_MS,
  keyStep,
  SCRUB_RANGE_DAYS,
  snapToHour,
  timelineLabels,
  timelineTicks,
} from "./timeline";

// Local times: the helpers work in the viewer's zone.
const VALUE = new Date(2026, 9, 3, 13, 30);
const NOW = new Date(2026, 9, 3, 13, 0);

describe("timelineTicks", () => {
  it("places hourly ticks over ±72 h with px offsets from the value", () => {
    const ticks = timelineTicks(VALUE, 10);
    expect(ticks).toHaveLength(144);
    expect(ticks.every((t) => t.time.getMinutes() === 0)).toBe(true);
    const at14 = ticks.find(
      (t) => t.time.getTime() === new Date(2026, 9, 3, 14).getTime(),
    );
    expect(at14?.offsetPx).toBe(5);
    const at13 = ticks.find(
      (t) => t.time.getTime() === new Date(2026, 9, 3, 13).getTime(),
    );
    expect(at13?.offsetPx).toBe(-5);
    expect(Math.abs(ticks[0].offsetPx)).toBeLessThanOrEqual(720);
    expect(ticks[ticks.length - 1].offsetPx).toBeLessThanOrEqual(720);
  });

  it("marks local midnights as day ticks", () => {
    const ticks = timelineTicks(VALUE, 10);
    const days = ticks.filter((t) => t.kind === "day");
    expect(days.length).toBe(6);
    expect(days.every((t) => t.time.getHours() === 0)).toBe(true);
  });

  it("includes a tick exactly at the edge when the value is on the hour", () => {
    const ticks = timelineTicks(NOW, 10);
    expect(ticks).toHaveLength(145);
    expect(ticks[0].offsetPx).toBe(-720);
  });
});

describe("day labels", () => {
  it("says Today for now's day and the short weekday otherwise", () => {
    expect(dayLabel(new Date(2026, 9, 3, 2), NOW)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 2, 12), NOW)).toBe("Fri");
    expect(dayLabel(new Date(2026, 9, 4, 12), NOW)).toBe("Sun");
  });

  it("centres one label per day at noon", () => {
    const labels = timelineLabels(VALUE, NOW, 10);
    expect(labels.map((l) => l.text)).toEqual([
      "Thu",
      "Fri",
      "Today",
      "Sun",
      "Mon",
      "Tue",
    ]);
    const today = labels.find((l) => l.today);
    expect(today?.offsetPx).toBe(-15);
  });
});

describe("formatMoonInstant", () => {
  it("formats en-GB weekday, day, month and 24-hour time", () => {
    expect(formatMoonInstant(new Date(2026, 9, 3, 13, 0))).toBe(
      "Saturday 3 October at 13:00",
    );
    expect(formatMoonInstant(new Date(2026, 9, 10, 7, 5))).toBe(
      "Saturday 10 October at 07:05",
    );
  });
});

describe("keyStep", () => {
  const v = NOW.getTime();
  it("moves an hour on arrows and a day with Shift or PageUp/PageDown", () => {
    expect(keyStep("ArrowRight", false, NOW, NOW)?.getTime()).toBe(v + HOUR_MS);
    expect(keyStep("ArrowLeft", false, NOW, NOW)?.getTime()).toBe(v - HOUR_MS);
    expect(keyStep("ArrowRight", true, NOW, NOW)?.getTime()).toBe(v + DAY_MS);
    expect(keyStep("ArrowLeft", true, NOW, NOW)?.getTime()).toBe(v - DAY_MS);
    expect(keyStep("PageUp", false, NOW, NOW)?.getTime()).toBe(v + DAY_MS);
    expect(keyStep("PageDown", false, NOW, NOW)?.getTime()).toBe(v - DAY_MS);
  });

  it("returns to now on Home and ignores other keys", () => {
    expect(keyStep("Home", false, VALUE, NOW)?.getTime()).toBe(v);
    expect(keyStep("a", false, VALUE, NOW)).toBeNull();
  });

  it("reaches days the calendar can page to, years out", () => {
    const yearOut = new Date(v + 2 * 365 * DAY_MS);
    expect(keyStep("ArrowRight", false, yearOut, NOW)?.getTime()).toBe(
      yearOut.getTime() + HOUR_MS,
    );
  });

  it("clamps to the scrub range", () => {
    const edge = new Date(v + SCRUB_RANGE_DAYS * DAY_MS);
    expect(keyStep("ArrowRight", false, edge, NOW)?.getTime()).toBe(
      edge.getTime(),
    );
  });
});

describe("drag", () => {
  it("moves back in time when the strip is dragged right", () => {
    expect(dragTo(NOW, 20, 10, NOW).getTime()).toBe(
      NOW.getTime() - 2 * HOUR_MS,
    );
    expect(dragTo(NOW, -5, 10, NOW).getTime()).toBe(
      NOW.getTime() + HOUR_MS / 2,
    );
  });

  it("snaps to the nearest local hour", () => {
    expect(snapToHour(new Date(2026, 9, 3, 13, 29))).toEqual(
      new Date(2026, 9, 3, 13),
    );
    expect(snapToHour(new Date(2026, 9, 3, 13, 31))).toEqual(
      new Date(2026, 9, 3, 14),
    );
  });
});
