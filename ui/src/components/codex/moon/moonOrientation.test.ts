import { Body, Illumination, Libration, MoonPhase } from "astronomy-engine";
import { describe, expect, it } from "vitest";
import {
  dot,
  type Mat3,
  mulMat3Vec3,
  orientMoon,
  type Vec3,
} from "./moonOrientation";

const DATES = [
  "2026-01-04T00:00:00Z",
  "2026-03-21T06:00:00Z",
  "2026-06-11T18:00:00Z",
  "2026-08-30T03:00:00Z",
  "2026-10-03T12:00:00Z",
  "2026-10-15T12:00:00Z",
  "2026-10-22T21:00:00Z",
  "2027-02-14T09:00:00Z",
].map((s) => new Date(s));

const DEG = Math.PI / 180;

function bodyDir(latDeg: number, lonDeg: number): Vec3 {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
}

function column(m: Mat3, j: number): Vec3 {
  return [m[j], m[3 + j], m[6 + j]];
}

function angleDeg(a: Vec3, b: Vec3): number {
  return Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) / DEG;
}

describe("orientMoon", () => {
  it("returns a proper rotation matrix", () => {
    for (const date of DATES) {
      const { bodyToView: m } = orientMoon(date);
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          expect(dot(column(m, i), column(m, j))).toBeCloseTo(
            i === j ? 1 : 0,
            9,
          );
        }
      }
      const det =
        m[0] * (m[4] * m[8] - m[5] * m[7]) -
        m[1] * (m[3] * m[8] - m[5] * m[6]) +
        m[2] * (m[3] * m[7] - m[4] * m[6]);
      expect(det).toBeCloseTo(1, 9);
    }
  });

  it("maps the sub-Earth point (libration) to +z within 0.5°", () => {
    for (const date of DATES) {
      const lib = Libration(date);
      const v = mulMat3Vec3(
        orientMoon(date).bodyToView,
        bodyDir(lib.elat, lib.elon),
      );
      expect(angleDeg(v, [0, 0, 1])).toBeLessThan(0.5);
    }
  });

  it("returns a unit sun direction whose phase matches Illumination", () => {
    for (const date of DATES) {
      const { sunDir } = orientMoon(date);
      expect(Math.hypot(...sunDir)).toBeCloseTo(1, 9);
      const fraction = (1 + sunDir[2]) / 2;
      expect(fraction).toBeCloseTo(
        Illumination(Body.Moon, date).phase_fraction,
        2,
      );
    }
  });

  it("puts the lit limb on the right (west) while waxing, left while waning", () => {
    for (const date of DATES) {
      const waxing = MoonPhase(date) < 180;
      expect(orientMoon(date).sunDir[0] > 0).toBe(waxing);
    }
  });

  it("keeps the lunar north pole roughly up", () => {
    for (const date of DATES) {
      const pole = column(orientMoon(date).bodyToView, 2);
      expect(pole[1]).toBeGreaterThan(0.85);
    }
  });
});
