import { describe, expect, it } from "vitest";
import { bezierPoint, describeMoon, sunArcPosition } from "./sky";

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
