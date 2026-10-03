import { Body, GeoMoon, GeoVector, RotationAxis } from "astronomy-engine";

export type Vec3 = [number, number, number];
/** 3×3 matrix, row-major. */
export type Mat3 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface MoonOrientation {
  /** Unit vector from the Moon toward the Sun, in the view frame. */
  sunDir: Vec3;
  /**
   * Rotation taking selenographic body-frame vectors into the view frame.
   * Body frame: +x toward lat 0 / lon 0, +z toward the lunar north pole,
   * +y toward lon 90°E. View frame: +z from the Moon toward the (geocentric)
   * viewer, +y celestial north projected onto the sky, +x = y × z (right on
   * screen, i.e. celestial west).
   */
  bodyToView: Mat3;
}

const DEG = Math.PI / 180;

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function scale(v: Vec3, k: number): Vec3 {
  return [v[0] * k, v[1] * k, v[2] * k];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function mulMat3Vec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Unit vector for right ascension / declination, both in degrees. */
function radec(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  return [
    Math.cos(dec) * Math.cos(ra),
    Math.cos(dec) * Math.sin(ra),
    Math.sin(dec),
  ];
}

/**
 * The selenographic body axes in J2000 equatorial (EQJ) coordinates, from
 * the IAU rotation model: pole (α, δ) and prime-meridian angle W measured
 * eastward along the lunar equator from its ascending node on the EQJ
 * equator.
 */
function bodyAxes(date: Date): { x: Vec3; y: Vec3; z: Vec3 } {
  const axis = RotationAxis(Body.Moon, date);
  const raDeg = axis.ra * 15; // sidereal hours → degrees
  const pole = radec(raDeg, axis.dec);
  const node = radec(raDeg + 90, 0);
  const w = axis.spin * DEG;
  const x = add(
    scale(node, Math.cos(w)),
    scale(cross(pole, node), Math.sin(w)),
  );
  return { x, y: cross(pole, x), z: pole };
}

/** View axes in EQJ coordinates for a geocentric observer facing the Moon. */
function viewAxes(moon: Vec3): { x: Vec3; y: Vec3; z: Vec3 } {
  const z = normalize(scale(moon, -1));
  const north: Vec3 = [0, 0, 1];
  const y = normalize(add(north, scale(z, -dot(north, z))));
  return { x: cross(y, z), y, z };
}

/** Real orientation and lighting of the Moon as seen from Earth's centre. */
export function orientMoon(date: Date): MoonOrientation {
  const m = GeoMoon(date);
  const s = GeoVector(Body.Sun, date, true);
  const moon: Vec3 = [m.x, m.y, m.z];
  const view = viewAxes(moon);
  const body = bodyAxes(date);
  const viewRows = [view.x, view.y, view.z];
  const bodyCols = [body.x, body.y, body.z];
  const bodyToView = viewRows.flatMap((row) =>
    bodyCols.map((col) => dot(row, col)),
  ) as Mat3;
  const sunEqj = normalize([s.x - m.x, s.y - m.y, s.z - m.z]);
  const sunDir: Vec3 = [
    dot(view.x, sunEqj),
    dot(view.y, sunEqj),
    dot(view.z, sunEqj),
  ];
  return { sunDir, bodyToView };
}
