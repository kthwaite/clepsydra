import { describe, expect, it } from "vitest";
import {
  axisAngleQuat,
  bodyToMeshQuaternion,
  dragQuat,
  mat3ToQuat,
  mulQuat,
  rotateVec,
  springStep,
} from "./globeMath";
import {
  type Mat3,
  mulMat3Vec3,
  orientMoon,
  type Vec3,
} from "./moonOrientation";

function expectVecClose(a: Vec3, b: Vec3, digits = 6) {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], digits);
}

function bodyDir(lonDeg: number, latDeg: number): Vec3 {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  return [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
}

describe("mat3ToQuat", () => {
  const cases: [Vec3, number][] = [
    [[0, 0, 1], 0.3],
    [[1, 0, 0], Math.PI - 1e-3],
    [[0, 1, 0], Math.PI],
    [[0, 0, 1], -Math.PI + 0.01],
    [[0.48, 0.6, 0.64], 2.2],
  ];
  it.each(cases)("round-trips axis %j angle %f", (axis, angle) => {
    const q = axisAngleQuat(axis, angle);
    // Build the matrix whose columns are the rotated basis vectors.
    const cx = rotateVec(q, [1, 0, 0]);
    const cy = rotateVec(q, [0, 1, 0]);
    const cz = rotateVec(q, [0, 0, 1]);
    const m: Mat3 = [
      cx[0],
      cy[0],
      cz[0],
      cx[1],
      cy[1],
      cz[1],
      cx[2],
      cy[2],
      cz[2],
    ];
    const back = mat3ToQuat(m);
    for (const v of [
      [1, 2, 3],
      [-0.5, 0.1, 0.9],
    ] as Vec3[]) {
      expectVecClose(rotateVec(back, v), mulMat3Vec3(m, v));
    }
  });
});

describe("bodyToMeshQuaternion", () => {
  it("lands each sphere UV on the matching selenographic direction", async () => {
    // Dynamic import keeps the three-import guard honest for test files too.
    const { SphereGeometry } = await import("three");
    const geo = new SphereGeometry(1, 64, 32);
    const pos = geo.getAttribute("position");
    const uv = geo.getAttribute("uv");
    for (const iso of ["2026-10-03T13:00:00Z", "2026-10-26T04:00:00Z"]) {
      const { bodyToView } = orientMoon(new Date(iso));
      const q = bodyToMeshQuaternion(bodyToView);
      // Skip the pole rows, whose u is offset by half a segment.
      for (const i of [
        65 * 5 + 3,
        65 * 12 + 32,
        65 * 16 + 0,
        65 * 16 + 48,
        65 * 27 + 60,
      ]) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        const lon = (u - 0.5) * 360;
        const lat = (v - 0.5) * 180;
        const local: Vec3 = [pos.getX(i), pos.getY(i), pos.getZ(i)];
        const expected = mulMat3Vec3(bodyToView, bodyDir(lon, lat));
        expectVecClose(rotateVec(q, local), expected, 5);
      }
    }
    geo.dispose();
  });

  it("puts texture centre (lon 0, lat 0) near the viewer", () => {
    const { bodyToView } = orientMoon(new Date("2026-10-03T13:00:00Z"));
    const q = bodyToMeshQuaternion(bodyToView);
    // u = 0.5, v = 0.5 is local +x on the three sphere.
    const toward = rotateVec(q, [1, 0, 0]);
    expect(toward[2]).toBeGreaterThan(Math.cos((10 * Math.PI) / 180));
  });
});

describe("dragQuat / mulQuat", () => {
  it("is identity at rest and yaws about view +y", () => {
    expectVecClose(rotateVec(dragQuat(0, 0), [0.2, 0.3, 0.9]), [0.2, 0.3, 0.9]);
    expectVecClose(rotateVec(dragQuat(Math.PI / 2, 0), [0, 0, 1]), [1, 0, 0]);
    expectVecClose(rotateVec(dragQuat(0, Math.PI / 2), [0, 0, 1]), [0, -1, 0]);
  });

  it("composes right-to-left", () => {
    const a = axisAngleQuat([0, 0, 1], Math.PI / 2);
    const b = axisAngleQuat([1, 0, 0], Math.PI / 2);
    const v: Vec3 = [0, 1, 0];
    expectVecClose(rotateVec(mulQuat(a, b), v), rotateVec(a, rotateVec(b, v)));
  });
});

describe("springStep", () => {
  it("settles to within 2% in ~600 ms at omega 10", () => {
    let x = 1;
    let v = 0;
    for (let t = 0; t < 0.6; t += 1 / 60) [x, v] = springStep(x, v, 1 / 60, 10);
    expect(Math.abs(x)).toBeLessThan(0.02);
    expect(x).toBeGreaterThanOrEqual(0); // critically damped: no overshoot
  });

  it("matches one big step to many small ones", () => {
    let x = 0.7;
    let v = -2;
    for (let i = 0; i < 100; i++) [x, v] = springStep(x, v, 0.003, 10);
    const [bx, bv] = springStep(0.7, -2, 0.3, 10);
    expect(x).toBeCloseTo(bx, 9);
    expect(v).toBeCloseTo(bv, 9);
  });
});
