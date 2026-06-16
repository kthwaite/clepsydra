import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DayArc } from "./DayArc";
import { MoonDisc } from "./MoonDisc";
import type { MoonInfo } from "./sky";

const GIBBOUS: MoonInfo = {
  phaseName: "Waxing gibbous",
  glyph: "🌔",
  illumPct: 72,
  waxing: true,
  terminatorScaleX: 0.44,
};

describe("sky components", () => {
  it("renders MoonDisc with a phase label", () => {
    render(
      <MoonDisc
        info={{
          phaseName: "Full",
          glyph: "🌕",
          illumPct: 100,
          waxing: false,
          terminatorScaleX: 1,
        }}
      />,
    );
    expect(screen.getByLabelText(/Full · 100%/)).toBeInTheDocument();
  });

  it("renders eight accessible phase ticks (bottom row is decorative)", () => {
    render(<MoonDisc info={GIBBOUS} />);
    // The bottom gauge is aria-hidden, so only the top row is exposed.
    expect(screen.getAllByRole("button")).toHaveLength(8);
    expect(
      screen.getByRole("button", { name: "First quarter" }),
    ).toBeInTheDocument();
  });

  it("marks the current phase tick with aria-current", () => {
    render(<MoonDisc info={GIBBOUS} />);
    expect(
      screen.getByRole("button", { name: "Waxing gibbous" }),
    ).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Full" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("names a phase in a tooltip on keyboard focus", async () => {
    const user = userEvent.setup();
    render(<MoonDisc info={GIBBOUS} />);
    // First tab lands on the first top-row tick ("New"); focus opens its tooltip.
    await user.tab();
    expect(screen.getByRole("button", { name: "New" })).toHaveFocus();
    await waitFor(() =>
      expect(screen.getByRole("tooltip")).toHaveTextContent("New"),
    );
  });

  it("renders DayArc as an svg", () => {
    const { container } = render(
      <DayArc t={0.5} x={300} y={8} sunriseLabel="05:54" sunsetLabel="20:31" />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
