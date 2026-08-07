import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bezierPoint,
  deriveSky,
  describeMoon,
  fallbackSunTimes,
  hasCoords,
  nextLocalDate,
  selectDisplayedSunrise,
  sunArcPosition,
} from "./sky";

describe("describeMoon", () => {
  it("names the new moon and marks it neither waxing nor full", () => {
    const m = describeMoon({ fraction: 0, phase: 0 });
    expect(m.phaseName).toBe("New");
    expect(m.illumPct).toBe(0);
  });
  it("treats phase < 0.5 as waxing and > 0.5 as waning", () => {
    expect(describeMoon({ fraction: 0.6, phase: 0.3 }).waxing).toBe(true);
    expect(describeMoon({ fraction: 0.6, phase: 0.7 }).waxing).toBe(false);
  });
  it("names the full moon at phase 0.5", () => {
    expect(describeMoon({ fraction: 1, phase: 0.5 }).phaseName).toBe("Full");
    expect(describeMoon({ fraction: 1, phase: 0.5 }).illumPct).toBe(100);
  });
});

describe("bezierPoint (day-arc quadratic)", () => {
  it("hits the endpoints", () => {
    expect(bezierPoint(0)).toEqual({ x: 24, y: 48 });
    expect(bezierPoint(1)).toEqual({ x: 576, y: 48 });
  });
  it("computes the midpoint", () => {
    expect(bezierPoint(0.5)).toEqual({ x: 300, y: 8 });
  });
});

describe("sunArcPosition", () => {
  const sunrise = new Date("2026-05-02T05:54:00Z");
  const sunset = new Date("2026-05-02T20:31:00Z");
  it("clamps to the horizon before sunrise and after sunset", () => {
    expect(
      sunArcPosition(new Date("2026-05-02T04:00:00Z"), sunrise, sunset).t,
    ).toBe(0);
    expect(
      sunArcPosition(new Date("2026-05-02T22:00:00Z"), sunrise, sunset).t,
    ).toBe(1);
  });
  it("is ~0.5 at solar midpoint", () => {
    const mid = new Date("2026-05-02T13:12:00Z");
    expect(sunArcPosition(mid, sunrise, sunset).t).toBeCloseTo(0.5, 1);
  });
});

describe("selectDisplayedSunrise", () => {
  const todaySunrise = new Date("2026-05-02T05:54:00Z");
  const todaySunset = new Date("2026-05-02T20:31:00Z");
  const tomorrowSunrise = new Date("2026-05-03T05:52:00Z");

  it("keeps today's sunrise before sunset without evaluating tomorrow", () => {
    const getTomorrow = vi.fn(() => tomorrowSunrise);
    expect(
      selectDisplayedSunrise(
        new Date("2026-05-02T20:30:59Z"),
        todaySunrise,
        todaySunset,
        getTomorrow,
      ),
    ).toEqual({ time: todaySunrise, isTomorrow: false });
    expect(getTomorrow).not.toHaveBeenCalled();
  });

  it.each([
    "2026-05-02T20:31:00Z",
    "2026-05-02T23:59:59Z",
  ])("uses tomorrow's sunrise at and after sunset (%s)", (now) => {
    expect(
      selectDisplayedSunrise(
        new Date(now),
        todaySunrise,
        todaySunset,
        () => tomorrowSunrise,
      ),
    ).toEqual({ time: tomorrowSunrise, isTomorrow: true });
  });

  it("uses the new current date's sunrise without an indicator after midnight", () => {
    const currentSunrise = new Date("2026-05-03T05:52:00Z");
    expect(
      selectDisplayedSunrise(
        new Date("2026-05-03T00:00:00Z"),
        currentSunrise,
        new Date("2026-05-03T20:33:00Z"),
        () => new Date("2026-05-04T05:50:00Z"),
      ),
    ).toEqual({ time: currentSunrise, isTomorrow: false });
  });
});

describe("hasCoords", () => {
  it("requires both coordinates", () => {
    expect(hasCoords(undefined)).toBe(false);
    expect(hasCoords({ latitude: 51.5 })).toBe(false);
    expect(hasCoords({ latitude: 51.5, longitude: null })).toBe(false);
    expect(hasCoords({ latitude: 51.5, longitude: -0.1 })).toBe(true);
    expect(hasCoords({ latitude: 0, longitude: 0 })).toBe(true);
  });
});

describe("deriveSky (fallback, no location)", () => {
  it("uses the fixed 06:00–20:00 day and formats telemetry", () => {
    const noon = new Date(2026, 7, 7, 12, 0, 0);
    const sky = deriveSky(noon, undefined);
    expect(sky.sunrise).toBe("06:00");
    expect(sky.sunset).toBe("20:00");
    expect(sky.sunriseIsTomorrow).toBe(false);
    expect(sky.lightLeft).toBe("8h 00m");
    expect(sky.arc.t).toBeCloseTo((12 - 6) / 14, 5);
    expect(sky.place).toBeNull();
    expect(sky.moon.phaseName).toBeTruthy();
  });

  it("clamps light-left at zero and points at tomorrow's sunrise after sunset", () => {
    const night = new Date(2026, 7, 7, 21, 30, 0);
    const sky = deriveSky(night, undefined);
    expect(sky.lightLeft).toBe("0h 00m");
    expect(sky.sunriseIsTomorrow).toBe(true);
    expect(sky.arc.t).toBe(1);
  });

  it("fallbackSunTimes pins hours on the given local day", () => {
    const { sunrise, sunset } = fallbackSunTimes(new Date(2026, 7, 7, 15));
    expect(sunrise.getHours()).toBe(6);
    expect(sunset.getHours()).toBe(20);
    expect(sunrise.getDate()).toBe(7);
  });
});

describe("nextLocalDate", () => {
  beforeEach(() => {
    vi.stubEnv("TZ", "America/New_York");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("advances across spring DST while retaining local clock fields", () => {
    const source = new Date(2026, 2, 7, 12, 34, 56, 789);
    const sourceTime = source.getTime();
    const next = nextLocalDate(source);

    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      "America/New_York",
    );
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(2);
    expect(next.getDate()).toBe(8);
    expect(next.getHours()).toBe(12);
    expect(next.getMinutes()).toBe(34);
    expect(next.getSeconds()).toBe(56);
    expect(next.getMilliseconds()).toBe(789);
    expect(next.getTime() - source.getTime()).toBe(23 * 60 * 60 * 1000);
    expect(source.getTime()).toBe(sourceTime);
  });
});
