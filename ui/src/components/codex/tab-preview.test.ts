import { describe, expect, it } from "vitest";
import { clampPreviewLeft, shouldPreviewTab } from "./tab-preview";

describe("clampPreviewLeft", () => {
  const W = 340;

  it("returns the rect left when fully on-screen", () => {
    expect(clampPreviewLeft(100, 1200, W)).toBe(100);
  });

  it("clamps to the right edge when the card would overflow", () => {
    // 1200 - 340 - 8 = 852
    expect(clampPreviewLeft(1100, 1200, W)).toBe(852);
  });

  it("clamps to the left margin when rect.left is negative", () => {
    expect(clampPreviewLeft(-50, 1200, W)).toBe(8);
  });
});

describe("shouldPreviewTab", () => {
  it("previews an inactive tab with a path", () => {
    expect(shouldPreviewTab("docs/a.md", "tab-1", "tab-2")).toBe(true);
  });

  it("suppresses the active tab", () => {
    expect(shouldPreviewTab("docs/a.md", "tab-1", "tab-1")).toBe(false);
  });

  it("suppresses a tab with no path", () => {
    expect(shouldPreviewTab(undefined, "tab-1", "tab-2")).toBe(false);
    expect(shouldPreviewTab("", "tab-1", "tab-2")).toBe(false);
  });

  it("suppresses a null active id without crashing", () => {
    expect(shouldPreviewTab("docs/a.md", "tab-1", null)).toBe(true);
  });
});
