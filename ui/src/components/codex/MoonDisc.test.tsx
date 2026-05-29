import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DayArc } from "./DayArc";
import { MoonDisc } from "./MoonDisc";

describe("sky components", () => {
  it("renders MoonDisc with a phase label", () => {
    const { getByLabelText } = render(
      <MoonDisc info={{ phaseName: "Full", glyph: "🌕", illumPct: 100, waxing: false, terminatorScaleX: 1 }} />,
    );
    expect(getByLabelText(/Full · 100%/)).toBeInTheDocument();
  });

  it("renders DayArc as an svg", () => {
    const { container } = render(
      <DayArc t={0.5} x={300} y={8} sunriseLabel="05:54" sunsetLabel="20:31" />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
