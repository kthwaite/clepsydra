import { describe, expect, it } from "vitest";
import { MOON_GLYPHS, MOON_NAMES } from "#/components/codex/sky";
import { monthPhases, moonAt } from "./moon";

const LONDON = { latitude: 51.5074, longitude: -0.1278 };
const MINUTE = 60_000;

// Reference instants (astronomy-engine SearchMoonQuarter, UTC).
const NEW_OCT = Date.parse("2026-10-10T15:50:37Z");
const FIRST_OCT = Date.parse("2026-10-18T16:13:19Z");
const FULL_OCT = Date.parse("2026-10-26T04:12:16Z");
const LAST_NOV = Date.parse("2026-11-01T20:28:59Z");

describe("moonAt", () => {
  it("reports a new moon at the October 2026 new-moon instant", () => {
    const m = moonAt(new Date(NEW_OCT));
    expect(m.phaseName).toBe(MOON_NAMES[0]);
    expect(m.glyph).toBe(MOON_GLYPHS[0]);
    expect(Math.min(m.phase, 1 - m.phase)).toBeLessThan(0.002);
    expect(m.illumFraction).toBeLessThan(0.01);
    expect(m.illumPct).toBe(0);
  });

  it("reports a full moon at the October 2026 full-moon instant", () => {
    const m = moonAt(new Date(FULL_OCT));
    expect(m.phaseName).toBe("Full");
    expect(m.glyph).toBe(MOON_GLYPHS[4]);
    expect(m.phase).toBeCloseTo(0.5, 2);
    expect(m.illumFraction).toBeGreaterThan(0.99);
    expect(m.illumPct).toBe(100);
  });

  it("marks waxing between new and full, waning after", () => {
    const first = moonAt(new Date(FIRST_OCT));
    expect(first.waxing).toBe(true);
    expect(first.phaseName).toBe("First quarter");
    expect(first.illumFraction).toBeCloseTo(0.5, 1);
    const last = moonAt(new Date(LAST_NOV));
    expect(last.waxing).toBe(false);
    expect(last.phaseName).toBe("Last quarter");
  });

  it("finds the next full and new moons", () => {
    const m = moonAt(new Date("2026-10-03T12:00:00Z"));
    expect(Math.abs(m.nextNew.getTime() - NEW_OCT)).toBeLessThan(MINUTE);
    expect(Math.abs(m.nextFull.getTime() - FULL_OCT)).toBeLessThan(MINUTE);
  });

  it("keeps the distance within the lunar perigee/apogee range", () => {
    for (let d = 0; d < 30; d += 3) {
      const m = moonAt(new Date(Date.UTC(2026, 9, 1 + d)));
      expect(m.distanceKm).toBeGreaterThan(356_000);
      expect(m.distanceKm).toBeLessThan(407_000);
    }
  });

  it("has no rise or set without a location", () => {
    const m = moonAt(new Date("2026-10-15T12:00:00Z"));
    expect(m.rise).toBeNull();
    expect(m.set).toBeNull();
    expect(moonAt(new Date("2026-10-15T12:00:00Z"), null).rise).toBeNull();
  });

  it("finds rise and set within the local day for London", () => {
    const at = new Date(2026, 9, 15, 12);
    const m = moonAt(at, LONDON);
    const start = new Date(2026, 9, 15).getTime();
    const end = new Date(2026, 9, 16).getTime();
    expect(m.rise).not.toBeNull();
    expect(m.set).not.toBeNull();
    for (const t of [m.rise, m.set]) {
      expect(t?.getTime()).toBeGreaterThanOrEqual(start);
      expect(t?.getTime()).toBeLessThan(end);
    }
  });
});

describe("monthPhases", () => {
  it("returns one entry per local day at noon", () => {
    const { days } = monthPhases(2026, 9);
    expect(days).toHaveLength(31);
    days.forEach((day, i) => {
      expect(day.date.getFullYear()).toBe(2026);
      expect(day.date.getMonth()).toBe(9);
      expect(day.date.getDate()).toBe(i + 1);
      expect(day.date.getHours()).toBe(12);
      expect(day.phase).toBeGreaterThanOrEqual(0);
      expect(day.phase).toBeLessThan(1);
      expect(day.illumFraction).toBeGreaterThanOrEqual(0);
      expect(day.illumFraction).toBeLessThanOrEqual(1);
    });
    // Waxing between the new moon (10th) and full moon (26th).
    expect(days[14].waxing).toBe(true);
    expect(days[28].waxing).toBe(false);
  });

  it("lists the quarter events inside the local month", () => {
    const { events } = monthPhases(2026, 9);
    const start = new Date(2026, 9, 1).getTime();
    const end = new Date(2026, 10, 1).getTime();
    for (const e of events) {
      expect(e.date.getTime()).toBeGreaterThanOrEqual(start);
      expect(e.date.getTime()).toBeLessThan(end);
    }
    const sorted = [...events].sort((a, b) => +a.date - +b.date);
    expect(events).toEqual(sorted);
    const newMoon = events.find((e) => e.kind === "new");
    expect(Math.abs((newMoon?.date.getTime() ?? 0) - NEW_OCT)).toBeLessThan(
      MINUTE,
    );
    const first = events.find((e) => e.kind === "first");
    expect(Math.abs((first?.date.getTime() ?? 0) - FIRST_OCT)).toBeLessThan(
      MINUTE,
    );
    expect(events.map((e) => e.kind)).toContain("full");
  });
});
