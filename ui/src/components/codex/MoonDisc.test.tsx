import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
const DATE = new Date("2026-10-22T12:00:00Z");

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
        date={DATE}
      />,
    );
    expect(screen.getByLabelText(/Full · 100%/)).toBeInTheDocument();
  });

  it("renders eight accessible phase ticks (bottom row is decorative)", () => {
    render(<MoonDisc info={GIBBOUS} date={DATE} />);
    // The bottom gauge is aria-hidden, so only the top row is exposed.
    expect(screen.getAllByRole("button")).toHaveLength(8);
    expect(
      screen.getByRole("button", { name: "First quarter" }),
    ).toBeInTheDocument();
  });

  it("marks the current phase tick with aria-current", () => {
    render(<MoonDisc info={GIBBOUS} date={DATE} />);
    expect(
      screen.getByRole("button", { name: "Waxing gibbous" }),
    ).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Full" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("names a phase in a tooltip on keyboard focus", async () => {
    const user = userEvent.setup();
    render(<MoonDisc info={GIBBOUS} date={DATE} />);
    // First tab lands on the first top-row tick ("New"); focus opens its tooltip.
    await user.tab();
    expect(screen.getByRole("button", { name: "New" })).toHaveFocus();
    await waitFor(() =>
      expect(screen.getByRole("tooltip")).toHaveTextContent("New"),
    );
  });

  it("draws the real moon face (CSS fallback in jsdom)", () => {
    const { container } = render(<MoonDisc info={GIBBOUS} date={DATE} />);
    expect(screen.getByRole("img", { name: /Moon, \d+% lit/ })).toBeVisible();
    expect(container.querySelector("[data-css-moon]")).not.toBeNull();
  });

  it("opens moon details from the disc when pressable", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<MoonDisc info={GIBBOUS} date={DATE} onOpen={onOpen} />);
    const disc = screen.getByRole("button", { name: "Moon details" });
    expect(disc).toHaveClass("rounded-full");
    expect(disc.className).toContain("data-[focus-visible]:ring-2");
    // The disc is not nested inside a phase tick, nor ticks inside it.
    expect(disc.closest("button")).toBe(disc);
    expect(disc.querySelector("button")).toBeNull();
    await user.click(disc);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("has no disc button without an open handler", () => {
    render(<MoonDisc info={GIBBOUS} date={DATE} />);
    expect(screen.queryByRole("button", { name: "Moon details" })).toBeNull();
  });

  it("renders DayArc as an svg", () => {
    const { container } = render(
      <DayArc t={0.5} x={300} y={8} sunriseLabel="05:54" sunsetLabel="20:31" />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("sets the disc on a sink tile with no border", () => {
    const { container } = render(<MoonDisc info={GIBBOUS} date={DATE} />);
    const figure = container.querySelector("figure");
    expect(figure).toHaveClass("bg-sink", "rounded-xl");
    expect(figure?.className).not.toMatch(/border/);
  });
});
