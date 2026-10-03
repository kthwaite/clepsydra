import { useEffect, useMemo, useRef, useState } from "react";
import { CssMoon } from "./CssMoon";
import { orientMoon } from "./moonOrientation";
import { loadMoonTexture } from "./moonTexture";
import { type MoonTexture, renderMoonDisc } from "./projectMoon";

const MINUTE_MS = 60_000;
const CACHE_LIMIT = 8;

/** Rendered discs keyed by `${minute}:${devicePixels}`, oldest first. */
const rendered = new Map<string, Uint8ClampedArray>();

function renderCached(
  minute: number,
  px: number,
  texture: MoonTexture,
): Uint8ClampedArray {
  const key = `${minute}:${px}`;
  const hit = rendered.get(key);
  if (hit) return hit;
  const pixels = renderMoonDisc({
    size: px,
    texture,
    orientation: orientMoon(new Date(minute * MINUTE_MS)),
  });
  rendered.set(key, pixels);
  if (rendered.size > CACHE_LIMIT) {
    const oldest = rendered.keys().next().value;
    if (oldest !== undefined) rendered.delete(oldest);
  }
  return pixels;
}

function useMoonTexture(): MoonTexture | null {
  const [texture, setTexture] = useState<MoonTexture | null>(null);
  useEffect(() => {
    let live = true;
    loadMoonTexture().then((t) => {
      if (live) setTexture(t);
    });
    return () => {
      live = false;
    };
  }, []);
  return texture;
}

/**
 * The Moon as it looks from Earth at `date`: the NASA colour map projected
 * onto a canvas and lit by the real Sun, north up. Shows {@link CssMoon}
 * until the texture loads, and keeps it where canvas 2D is unavailable.
 */
export function MoonFace({
  date,
  size,
  className,
}: {
  date: Date;
  /** Edge length in CSS pixels. */
  size: number;
  className?: string;
}) {
  const minute = Math.floor(date.getTime() / MINUTE_MS);
  const { sunDir } = useMemo(
    () => orientMoon(new Date(minute * MINUTE_MS)),
    [minute],
  );
  const illumPct = Math.round(((1 + sunDir[2]) / 2) * 100);
  const waxing = sunDir[0] > 0;
  const label = `Moon, ${illumPct}% lit`;

  const texture = useMoonTexture();
  const [canvasFailed, setCanvasFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const px = Math.max(1, Math.round(size * dpr));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !texture) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCanvasFailed(true);
      return;
    }
    const image = ctx.createImageData(px, px);
    image.data.set(renderCached(minute, px, texture));
    ctx.putImageData(image, 0, 0);
  }, [texture, minute, px]);

  if (!texture || canvasFailed) {
    return (
      <div role="img" aria-label={label} className={className}>
        <CssMoon illumPct={illumPct} waxing={waxing} size={size} />
      </div>
    );
  }
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={label}
      width={px}
      height={px}
      className={className}
      style={{ width: `${size}px`, height: `${size}px` }}
    />
  );
}
