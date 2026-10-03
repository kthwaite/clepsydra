import type { MoonTexture } from "./projectMoon";

const TEXTURE_URL = "/moon/moon-color-1k.webp";

let cached: Promise<MoonTexture | null> | null = null;

function pixelsOf(bitmap: ImageBitmap): MoonTexture | null {
  const { width, height } = bitmap;
  const canvas =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  const image = ctx.getImageData(0, 0, width, height);
  return { width: image.width, height: image.height, data: image.data };
}

async function decode(): Promise<MoonTexture | null> {
  if (typeof createImageBitmap !== "function") return null;
  const res = await fetch(TEXTURE_URL);
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob());
  try {
    return pixelsOf(bitmap);
  } finally {
    bitmap.close?.();
  }
}

/**
 * The card moon's colour map as RGBA pixels, loaded once per page. Resolves
 * null where images cannot be decoded (jsdom) or the load fails; a failed
 * load is forgotten so a later caller retries.
 */
export function loadMoonTexture(): Promise<MoonTexture | null> {
  if (!cached) {
    cached = decode()
      .catch(() => null)
      .then((texture) => {
        if (!texture) cached = null;
        return texture;
      });
  }
  return cached;
}

/** Test seam: drop the cached texture. */
export function resetMoonTextureCache(): void {
  cached = null;
}
