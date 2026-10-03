import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoonTexture } from "./projectMoon";

const loadMoonTexture = vi.fn<() => Promise<MoonTexture | null>>();
vi.mock("./moonTexture", () => ({
  loadMoonTexture: () => loadMoonTexture(),
}));

const { MoonFace } = await import("./MoonFace");

const DATE = new Date("2026-10-26T04:00:00Z"); // full moon

function flat(): MoonTexture {
  const data = new Uint8ClampedArray(8 * 4 * 4).fill(200);
  return { width: 8, height: 4, data };
}

describe("MoonFace", () => {
  beforeEach(() => {
    loadMoonTexture.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the CSS moon while the texture is unavailable", () => {
    loadMoonTexture.mockResolvedValue(null);
    const { container } = render(<MoonFace date={DATE} size={64} />);
    expect(screen.getByRole("img", { name: /Moon, 100% lit/ })).toBeVisible();
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("[data-css-moon]")).not.toBeNull();
  });

  it("keeps the CSS moon when canvas 2D is unavailable", async () => {
    loadMoonTexture.mockResolvedValue(flat());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { container } = render(<MoonFace date={DATE} size={64} />);
    await waitFor(() => expect(loadMoonTexture).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector("[data-css-moon]")).not.toBeNull(),
    );
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("paints the projected moon into a canvas at device pixel ratio", async () => {
    loadMoonTexture.mockResolvedValue(flat());
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
    const putImageData = vi.fn();
    const ctx = {
      createImageData: (w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
      putImageData,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    const { container } = render(<MoonFace date={DATE} size={64} />);
    await waitFor(() => expect(putImageData).toHaveBeenCalledOnce());
    const canvas = container.querySelector("canvas");
    expect(canvas).toHaveAttribute("role", "img");
    expect(canvas).toHaveAttribute("aria-label", "Moon, 100% lit");
    expect(canvas?.width).toBe(128);
    expect(canvas?.style.width).toBe("64px");
    const image = putImageData.mock.calls[0][0] as { data: Uint8ClampedArray };
    // Centre pixel of a full moon is lit and opaque.
    const i = (64 * 128 + 64) * 4;
    expect(image.data[i + 3]).toBe(255);
    expect(image.data[i]).toBeGreaterThan(120);
  });
});
