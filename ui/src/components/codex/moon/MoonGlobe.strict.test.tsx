import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A WebGL stand-in: once a canvas's context has been forcibly lost, a new
// renderer on that same canvas fails, as three does in a real browser.
const lost = new WeakSet<HTMLCanvasElement>();
const created: HTMLCanvasElement[] = [];

vi.mock("three", async (importOriginal) => {
  const three = await importOriginal<typeof import("three")>();
  class FakeRenderer {
    canvas: HTMLCanvasElement;
    outputColorSpace = "";
    capabilities = { getMaxAnisotropy: () => 1 };
    constructor({ canvas }: { canvas: HTMLCanvasElement }) {
      if (lost.has(canvas)) {
        throw new TypeError(
          "Cannot read properties of null (reading 'precision')",
        );
      }
      this.canvas = canvas;
      created.push(canvas);
    }
    setPixelRatio() {}
    setClearColor() {}
    setSize() {}
    render() {}
    dispose() {}
    forceContextLoss() {
      lost.add(this.canvas);
    }
  }
  class FakeLoader {
    load() {}
  }
  return { ...three, WebGLRenderer: FakeRenderer, TextureLoader: FakeLoader };
});

const { default: MoonGlobe } = await import("./MoonGlobe");

describe("MoonGlobe under StrictMode", () => {
  beforeEach(() => {
    created.length = 0;
    vi.stubGlobal("WebGLRenderingContext", class {});
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("survives the mount → cleanup → mount cycle with a fresh canvas", () => {
    render(
      <StrictMode>
        <MoonGlobe
          date={new Date("2026-10-03T13:00:00Z")}
          fallback={<p>flat moon</p>}
        />
      </StrictMode>,
    );
    expect(screen.queryByText("flat moon")).not.toBeInTheDocument();
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(created.length).toBeGreaterThanOrEqual(1);
    const live = created.at(-1);
    expect(live && lost.has(live)).toBe(false);
    expect(live?.isConnected).toBe(true);
    // Only the live canvas stays in the document.
    expect(document.querySelectorAll("canvas")).toHaveLength(1);
  });
});
