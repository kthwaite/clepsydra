import { clsx } from "clsx";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Mesh,
  NoColorSpace,
  OrthographicCamera,
  Quaternion,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  bodyToMeshQuaternion,
  dragQuat,
  mulQuat,
  springStep,
} from "./globeMath";
import { orientMoon } from "./moonOrientation";

export interface MoonGlobeProps {
  date: Date;
  /** CSS pixels. Omitted → fills its container as a square. */
  size?: number;
  className?: string;
  /** Rendered instead when WebGL is unavailable. */
  fallback: ReactNode;
}

const COLOR_URL = "/moon/moon-color-4k.webp";
const RELIEF_URL = "/moon/moon-relief-2k.webp";
/** Sphere diameter as a fraction of the canvas. */
const FILL = 0.88;
/** Spring stiffness: critically damped, settles in ~600 ms. */
const OMEGA = 10;
/** Drag radians per CSS pixel, relative to the globe's diameter. */
const DRAG_GAIN = Math.PI;
const MAX_PITCH = 1.3;
/** Relief height scale, radius units per unit of map value (map spans ~20 km ≈ 0.0115 radius, so ~2× exaggerated). */
const BUMP = 0.025;
/** Earthshine, as a fraction of full sunlight. */
const EARTHSHINE = 0.012;

const VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vEastW;
void main() {
  vUv = uv;
  vec3 n = normalize(position);
  // Local north pole is +y, so d/dlon = Y × n (length cos lat).
  vec3 east = vec3(n.z, 0.0, -n.x);
  mat3 rot = mat3(modelMatrix);
  vNormalW = rot * n;
  vEastW = rot * east;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Lommel–Seeliger with a little Lambert: the regolith's flat, bright limb.
const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform sampler2D relief;
uniform vec2 reliefTexel;
uniform vec3 sunDir;
uniform float bump;
uniform float earthshine;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vEastW;

float h(vec2 uv) { return texture2D(relief, uv).r; }

void main() {
  vec3 n = normalize(vNormalW);
  float cosLat = length(vEastW);
  vec3 east = cosLat > 1e-4 ? vEastW / cosLat : vec3(1.0, 0.0, 0.0);
  vec3 north = cross(n, east);

  vec2 du = vec2(reliefTexel.x, 0.0);
  vec2 dv = vec2(0.0, reliefTexel.y);
  // Slopes per radian of longitude / latitude.
  float dhdLon = (h(vUv + du) - h(vUv - du)) / (2.0 * reliefTexel.x * 6.2831853);
  float dhdLat = (h(vUv + dv) - h(vUv - dv)) / (2.0 * reliefTexel.y * 3.1415927);
  vec3 grad = (dhdLon / max(cosLat, 0.25)) * east + dhdLat * north;
  vec3 view = vec3(0.0, 0.0, 1.0);
  float facing = dot(n, view);
  // Fade relief out at the limb, where it only aliases.
  vec3 nb = normalize(n - bump * smoothstep(0.05, 0.5, facing) * grad);

  vec3 albedo = texture2D(map, vUv).rgb;
  // Slight wrap so sub-texel slopes don't pinch to black specks.
  float mu0 = max(dot(nb, sunDir) + 0.03, 0.0) / 1.03;
  float mu = max(dot(nb, view), 0.05);
  float ls = 2.0 * mu0 / (mu0 + mu);
  float shade = mix(ls, mu0, 0.15);
  // Soften the geometric terminator a touch.
  shade *= smoothstep(-0.02, 0.06, dot(n, sunDir));
  float lit = 1.25 * shade + earthshine * max(facing, 0.0);
  gl_FragColor = vec4(albedo * lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function hasWebGL(): boolean {
  if (typeof window === "undefined") return false;
  // Context creation itself is attempted (and caught) in createStage.
  return typeof WebGLRenderingContext !== "undefined";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface Stage {
  renderer: WebGLRenderer;
  material: ShaderMaterial;
  mesh: Mesh;
  /** Re-render once on the next frame. */
  invalidate: () => void;
  setTrue: (date: Date) => void;
  /** Drag offset; the stage animates it back to 0 when released. */
  drag: {
    yaw: number;
    pitch: number;
    vYaw: number;
    vPitch: number;
    held: boolean;
  };
  release: () => void;
  dispose: () => void;
}

function createStage(canvas: HTMLCanvasElement, onReady: () => void): Stage {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const half = 1 / FILL;
  const camera = new OrthographicCamera(-half, half, half, -half, 0.1, 10);
  camera.position.set(0, 0, 5);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  const geometry = new SphereGeometry(1, 128, 64);
  const material = new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      map: { value: null },
      relief: { value: null },
      reliefTexel: { value: new Vector2(1 / 2048, 1 / 1024) },
      sunDir: { value: new Vector3(0, 0, 1) },
      bump: { value: BUMP },
      earthshine: { value: EARTHSHINE },
    },
  });
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);

  const trueQ = new Quaternion();
  const drag = { yaw: 0, pitch: 0, vYaw: 0, vPitch: 0, held: false };
  let frame = 0;
  let lastT = 0;
  let disposed = false;
  let loaded = 0;
  const textures: Texture[] = [];

  const applyQuat = () => {
    const [x, y, z, w] = mulQuat(dragQuat(drag.yaw, drag.pitch), [
      trueQ.x,
      trueQ.y,
      trueQ.z,
      trueQ.w,
    ]);
    mesh.quaternion.set(x, y, z, w);
  };

  const draw = () => {
    if (loaded < 2) return;
    applyQuat();
    renderer.render(scene, camera);
  };

  const tick = (t: number) => {
    frame = 0;
    const dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 1 / 60;
    lastT = t;
    if (!drag.held) {
      [drag.yaw, drag.vYaw] = springStep(drag.yaw, drag.vYaw, dt, OMEGA);
      [drag.pitch, drag.vPitch] = springStep(
        drag.pitch,
        drag.vPitch,
        dt,
        OMEGA,
      );
      const resting =
        Math.abs(drag.yaw) + Math.abs(drag.pitch) < 1e-4 &&
        Math.abs(drag.vYaw) + Math.abs(drag.vPitch) < 1e-3;
      if (resting) {
        drag.yaw = drag.pitch = drag.vYaw = drag.vPitch = 0;
        lastT = 0;
        draw();
        return;
      }
      draw();
      frame = requestAnimationFrame(tick);
      return;
    }
    lastT = 0;
    draw();
  };

  const invalidate = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(tick);
  };

  const loader = new TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const load = (url: string, uniform: "map" | "relief", srgb: boolean) => {
    loader.load(url, (tex) => {
      if (disposed) {
        tex.dispose();
        return;
      }
      tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
      tex.wrapS = RepeatWrapping;
      tex.anisotropy = maxAniso;
      tex.needsUpdate = true;
      textures.push(tex);
      material.uniforms[uniform].value = tex;
      loaded += 1;
      if (loaded === 2) {
        invalidate();
        onReady();
      }
    });
  };
  load(COLOR_URL, "map", true);
  load(RELIEF_URL, "relief", false);

  return {
    renderer,
    material,
    mesh,
    drag,
    invalidate,
    setTrue(date) {
      const { sunDir, bodyToView } = orientMoon(date);
      const [x, y, z, w] = bodyToMeshQuaternion(bodyToView);
      trueQ.set(x, y, z, w);
      material.uniforms.sunDir.value.set(...sunDir).normalize();
      invalidate();
    },
    release() {
      drag.held = false;
      if (prefersReducedMotion()) {
        drag.yaw = drag.pitch = drag.vYaw = drag.vPitch = 0;
      }
      invalidate();
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      geometry.dispose();
      material.dispose();
      for (const t of textures) t.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

/** Live 3D moon: real libration, pole angle and sunlight. Drag to spin. */
export default function MoonGlobe({
  date,
  size,
  className,
  fallback,
}: MoonGlobeProps) {
  const [supported, setSupported] = useState(hasWebGL);
  const [ready, setReady] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const time = date.getTime();
  const timeRef = useRef(time);
  timeRef.current = time;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!supported || !canvas || !wrap) return;
    let stage: Stage;
    try {
      stage = createStage(canvas, () => setReady(true));
    } catch {
      setSupported(false);
      return;
    }
    stageRef.current = stage;
    stage.setTrue(new Date(timeRef.current));
    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w > 0 && h > 0) {
        stage.renderer.setSize(w, h, false);
        stage.invalidate();
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      stage.dispose();
      stageRef.current = null;
    };
  }, [supported]);

  useEffect(() => {
    stageRef.current?.setTrue(new Date(time));
  }, [time]);

  if (!supported) return <>{fallback}</>;

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const stage = stageRef.current;
    if (!stage || pointer.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointer.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    stage.drag.held = true;
    stage.drag.vYaw = stage.drag.vPitch = 0;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const stage = stageRef.current;
    const p = pointer.current;
    if (!stage || !p || p.id !== e.pointerId) return;
    const diameter = Math.max(e.currentTarget.clientWidth * FILL, 1);
    const k = DRAG_GAIN / diameter;
    stage.drag.yaw += (e.clientX - p.x) * k;
    stage.drag.pitch = Math.max(
      -MAX_PITCH,
      Math.min(MAX_PITCH, stage.drag.pitch + (e.clientY - p.y) * k),
    );
    p.x = e.clientX;
    p.y = e.clientY;
    stage.invalidate();
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointer.current?.id !== e.pointerId) return;
    pointer.current = null;
    stageRef.current?.release();
  };

  return (
    <div
      ref={wrapRef}
      className={clsx(
        "relative",
        size === undefined && "aspect-square w-full",
        className,
      )}
      style={size === undefined ? undefined : { width: size, height: size }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="The Moon as lit by the Sun at this moment; drag to turn it"
        className={clsx(
          "absolute inset-0 block h-full w-full cursor-grab touch-none transition-opacity duration-500 active:cursor-grabbing",
          ready ? "opacity-100" : "opacity-0",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      />
    </div>
  );
}
