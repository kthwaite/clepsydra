import type { Mat3, Vec3 } from "./moonOrientation";

/** Unit quaternion as `[x, y, z, w]` (three.js component order). */
export type Quat = [number, number, number, number];

/**
 * three.js `SphereGeometry` local axes → selenographic body axes.
 *
 * The sphere puts texture (u, v) at
 * `(-cos φ sin θ, cos θ, sin φ sin θ)` with φ = 2πu and θ = π(1 − v).
 * Our equirectangular maps put lon 0 at u = 0.5, so φ = lon + π and the
 * vertex is `(cos lat cos lon, sin lat, −cos lat sin lon)`.
 * Body frame is `(cos lat cos lon, cos lat sin lon, sin lat)`, so
 * body = (local.x, −local.z, local.y). Row-major.
 */
export const SPHERE_LOCAL_TO_BODY: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0];

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out as Mat3;
}

/** Rotation matrix (row-major) → unit quaternion (Shepperd's method). */
export function mat3ToQuat(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/**
 * Mesh quaternion for a three.js sphere carrying our moon textures, with
 * the camera on +z looking at the origin and +y up (world = view frame).
 */
export function bodyToMeshQuaternion(bodyToView: Mat3): Quat {
  return mat3ToQuat(mulMat3(bodyToView, SPHERE_LOCAL_TO_BODY));
}

/** Hamilton product `a · b` (apply b first, then a). */
export function mulQuat(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Quaternion for a rotation of `angle` radians about unit `axis`. */
export function axisAngleQuat(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** Rotate `v` by unit quaternion `q`. */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 q.xyz × v; v' = v + w t + q.xyz × t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/**
 * Drag offset on top of the true orientation: yaw about view +y, then
 * pitch about view +x, both in the view frame.
 */
export function dragQuat(yaw: number, pitch: number): Quat {
  return mulQuat(
    axisAngleQuat([1, 0, 0], pitch),
    axisAngleQuat([0, 1, 0], yaw),
  );
}

/**
 * One step of a critically damped spring toward 0. Exact solution, so it
 * is stable for any `dt`. Returns `[x, v]`.
 */
export function springStep(
  x: number,
  v: number,
  dt: number,
  omega: number,
): [number, number] {
  const e = Math.exp(-omega * dt);
  const c = v + omega * x;
  return [(x + c * dt) * e, (v - omega * c * dt) * e];
}
