import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMoonTexture, resetMoonTextureCache } from "./moonTexture";

describe("loadMoonTexture", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetMoonTextureCache();
  });

  it("resolves null without fetching when images cannot be decoded", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("createImageBitmap", undefined);
    await expect(loadMoonTexture()).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads the 1k colour map once and caches the promise", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(),
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 2, height: 1, close: () => {} }),
    );
    const data = new Uint8ClampedArray(8).fill(9);
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return {
            drawImage: () => {},
            getImageData: () => ({ width: 2, height: 1, data }),
          };
        }
      },
    );
    const a = loadMoonTexture();
    const b = loadMoonTexture();
    expect(a).toBe(b);
    await expect(a).resolves.toEqual({ width: 2, height: 1, data });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith("/moon/moon-color-1k.webp");
  });

  it("forgets a failed load so a later mount can retry", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(loadMoonTexture()).resolves.toBeNull();
    const again = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", again);
    await loadMoonTexture();
    expect(again).toHaveBeenCalledOnce();
  });
});
