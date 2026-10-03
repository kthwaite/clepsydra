import {
  dot,
  type Mat3,
  type MoonOrientation,
  type Vec3,
} from "./moonOrientation";

/** Equirectangular RGBA map: x = 0 → lon −180°, y = 0 → lat +90°. */
export interface MoonTexture {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface RenderMoonDiscInput {
  /** Output edge length in device pixels. */
  size: number;
  texture: MoonTexture;
  orientation: MoonOrientation;
  /** Ambient light on the night side, 0..1. */
  earthshine?: number;
}

const DEG = 180 / Math.PI;
const DEFAULT_EARTHSHINE = 0.04;
/** Half-width of the soft terminator band, in cos(incidence). */
const TERMINATOR_BAND = 0.06;
/** Weight of Lommel–Seeliger (flat, "lunar") over Lambert shading. */
const LUNAR_WEIGHT = 0.6;
/** Strength of the mild limb darkening. */
const LIMB = 0.2;

/** Transpose(m) · v — the inverse of a rotation matrix applied to v. */
function mulTransposeVec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function bodyLatLon(body: Vec3): { lat: number; lon: number } {
  const z = Math.min(1, Math.max(-1, body[2]));
  return { lat: Math.asin(z) * DEG, lon: Math.atan2(body[1], body[0]) * DEG };
}

/**
 * Selenographic lat/lon (degrees, east-positive) under a point of the disc.
 * `px`, `py` are disc coordinates in −1..1 with +y up (north) and +x right
 * (celestial west). Returns null outside the disc.
 */
export function viewToLatLon(
  px: number,
  py: number,
  bodyToView: Mat3,
): { lat: number; lon: number } | null {
  const rho2 = px * px + py * py;
  if (rho2 > 1) return null;
  const n: Vec3 = [px, py, Math.sqrt(1 - rho2)];
  return bodyLatLon(mulTransposeVec3(bodyToView, n));
}

/** Bilinear RGB sample, wrapping in longitude and clamping in latitude. */
function sample(
  tex: MoonTexture,
  lat: number,
  lon: number,
  out: [number, number, number],
): void {
  const { width: w, height: h, data } = tex;
  const u = ((lon + 180) / 360) * w - 0.5;
  const v = Math.min(h - 1, Math.max(0, ((90 - lat) / 180) * h - 0.5));
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const xa = ((x0 % w) + w) % w;
  const xb = (xa + 1) % w;
  const ya = y0;
  const yb = Math.min(h - 1, y0 + 1);
  const i00 = (ya * w + xa) * 4;
  const i10 = (ya * w + xb) * 4;
  const i01 = (yb * w + xa) * 4;
  const i11 = (yb * w + xb) * 4;
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
    const bottom = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
}

/** Light reaching the eye from a surface point, before albedo. */
function shade(n: Vec3, sunDir: Vec3, earthshine: number): number {
  const mu0 = dot(n, sunDir);
  const mu = n[2];
  const lit = smoothstep(-TERMINATOR_BAND, TERMINATOR_BAND, mu0);
  const inc = Math.max(0, mu0);
  const lunar = inc + mu > 0 ? (2 * inc) / (inc + mu) : 0;
  const diffuse = Math.min(
    1.15,
    LUNAR_WEIGHT * lunar + (1 - LUNAR_WEIGHT) * inc,
  );
  const limb = 1 - LIMB + LIMB * Math.sqrt(Math.max(0, mu));
  return lit * diffuse * limb + (1 - lit) * earthshine;
}

/**
 * Render the Moon as seen from Earth: an orthographic projection of the
 * texture, lit by the real Sun direction. Returns size×size RGBA with a
 * transparent surround and an anti-aliased limb.
 */
export function renderMoonDisc({
  size,
  texture,
  orientation,
  earthshine = DEFAULT_EARTHSHINE,
}: RenderMoonDiscInput): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const radius = size / 2;
  const rgb: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < size; y++) {
    const dy = radius - (y + 0.5);
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - radius;
      const dist = Math.hypot(dx, dy);
      const alpha = Math.min(1, Math.max(0, radius - dist));
      if (alpha <= 0) continue;
      const scale = dist > radius ? radius / dist : 1;
      const px = (dx * scale) / radius;
      const py = (dy * scale) / radius;
      const n: Vec3 = [px, py, Math.sqrt(Math.max(0, 1 - px * px - py * py))];
      const { lat, lon } = bodyLatLon(
        mulTransposeVec3(orientation.bodyToView, n),
      );
      sample(texture, lat, lon, rgb);
      const light = shade(n, orientation.sunDir, earthshine);
      const i = (y * size + x) * 4;
      out[i] = rgb[0] * light;
      out[i + 1] = rgb[1] * light;
      out[i + 2] = rgb[2] * light;
      out[i + 3] = alpha * 255;
    }
  }
  return out;
}
