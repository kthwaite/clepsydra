import { Libration } from "astronomy-engine";
import { describe, expect, it } from "vitest";
import { orientMoon } from "./moonOrientation";
import { type MoonTexture, renderMoonDisc, viewToLatLon } from "./projectMoon";

/** A flat mid-grey texture, so brightness depends only on shading. */
function flatTexture(value = 200): MoonTexture {
  const width = 16;
  const height = 8;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function pixel(out: Uint8ClampedArray, size: number, x: number, y: number) {
  const i = (y * size + x) * 4;
  return { r: out[i], g: out[i + 1], b: out[i + 2], a: out[i + 3] };
}

function angularDiffDeg(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

const SIZE = 64;
const MID = SIZE / 2;
// 2026-10-26 full moon; 2026-10-10 new moon (UTC dates).
const FULL = new Date("2026-10-26T04:00:00Z");
const NEW = new Date("2026-10-10T16:00:00Z");
// Near first and last quarter.
const FIRST_Q = new Date("2026-10-18T16:00:00Z");
const LAST_Q = new Date("2026-10-03T12:00:00Z");

describe("viewToLatLon", () => {
  it("maps the disc centre to the sub-Earth point (libration)", () => {
    for (const iso of [
      "2026-01-04T00:00:00Z",
      "2026-06-11T18:00:00Z",
      "2026-10-03T12:00:00Z",
    ]) {
      const date = new Date(iso);
      const lib = Libration(date);
      const hit = viewToLatLon(0, 0, orientMoon(date).bodyToView);
      expect(hit).not.toBeNull();
      expect(Math.abs((hit?.lat ?? 99) - lib.elat)).toBeLessThan(1);
      expect(angularDiffDeg(hit?.lon ?? 999, lib.elon)).toBeLessThan(1);
    }
  });

  it("puts the lunar north pole near the top of the disc", () => {
    const hit = viewToLatLon(0, 0.999, orientMoon(FULL).bodyToView);
    expect(hit?.lat).toBeGreaterThan(60);
  });

  it("returns null outside the disc", () => {
    expect(viewToLatLon(0.9, 0.9, orientMoon(FULL).bodyToView)).toBeNull();
  });
});

describe("renderMoonDisc", () => {
  const texture = flatTexture();

  it("returns size×size RGBA", () => {
    const out = renderMoonDisc({
      size: SIZE,
      texture,
      orientation: orientMoon(FULL),
    });
    expect(out).toHaveLength(SIZE * SIZE * 4);
  });

  it("leaves the corners transparent and the centre opaque", () => {
    const out = renderMoonDisc({
      size: SIZE,
      texture,
      orientation: orientMoon(FULL),
    });
    expect(pixel(out, SIZE, 0, 0).a).toBe(0);
    expect(pixel(out, SIZE, SIZE - 1, SIZE - 1).a).toBe(0);
    expect(pixel(out, SIZE, MID, MID).a).toBe(255);
  });

  it("anti-aliases the limb with partial alpha", () => {
    const out = renderMoonDisc({
      size: SIZE,
      texture,
      orientation: orientMoon(FULL),
    });
    const alphas = new Set<number>();
    for (let x = 0; x < SIZE; x++) alphas.add(pixel(out, SIZE, x, MID).a);
    expect([...alphas].some((a) => a > 0 && a < 255)).toBe(true);
  });

  it("lights the centre at full moon", () => {
    const out = renderMoonDisc({
      size: SIZE,
      texture,
      orientation: orientMoon(FULL),
    });
    expect(pixel(out, SIZE, MID, MID).r).toBeGreaterThan(150);
  });

  it("darkens the centre at new moon to earthshine only", () => {
    const out = renderMoonDisc({
      size: SIZE,
      texture,
      orientation: orientMoon(NEW),
    });
    expect(pixel(out, SIZE, MID, MID).r).toBeLessThan(20);
  });

  it("lights the right side at first quarter (waxing)", () => {
    const out = renderMoonDisc({
      size: SIZE,
      texture,
      orientation: orientMoon(FIRST_Q),
    });
    const right = pixel(out, SIZE, MID + 20, MID).r;
    const left = pixel(out, SIZE, MID - 20, MID).r;
    expect(right).toBeGreaterThan(100);
    expect(left).toBeLessThan(20);
  });

  it("lights the left side at last quarter (waning)", () => {
    const out = renderMoonDisc({
      size: SIZE,
      texture,
      orientation: orientMoon(LAST_Q),
    });
    const right = pixel(out, SIZE, MID + 20, MID).r;
    const left = pixel(out, SIZE, MID - 20, MID).r;
    expect(left).toBeGreaterThan(100);
    expect(right).toBeLessThan(20);
  });

  it("samples the texture by selenographic longitude", () => {
    // Left half of the map (lon < 0, west) black; right half (east) white.
    const width = 64;
    const height = 32;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = x < width / 2 ? 0 : 255;
        const i = (y * width + x) * 4;
        data.set([v, v, v, 255], i);
      }
    }
    const out = renderMoonDisc({
      size: SIZE,
      texture: { width, height, data },
      orientation: orientMoon(FULL),
    });
    // Seen from Earth with north up, lunar east is on the right.
    expect(pixel(out, SIZE, MID + 16, MID).r).toBeGreaterThan(120);
    expect(pixel(out, SIZE, MID - 16, MID).r).toBeLessThan(30);
  });
});
