import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PhaseGlyph } from "./PhaseGlyph";

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  );
}

describe("PhaseGlyph", () => {
  it("draws the lit portion lighter than the night side, in any theme", () => {
    render(<PhaseGlyph illumFraction={0.7} waxing={false} />);
    const svg = screen.getByTestId("phase-glyph");
    const night = svg.querySelector("circle")?.getAttribute("fill") ?? "";
    const lit = svg.querySelector("path")?.getAttribute("fill") ?? "";
    expect(night).toMatch(/^#[0-9a-f]{6}$/i);
    expect(lit).toMatch(/^#[0-9a-f]{6}$/i);
    expect(luminance(lit)).toBeGreaterThan(luminance(night) + 100);
  });
});
