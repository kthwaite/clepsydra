import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MoonTimeline } from "./MoonTimeline";
import { DAY_MS, HOUR_MS } from "./timeline";

const NOW = new Date(2026, 9, 3, 13, 0);

function setup(value = NOW) {
  const onChange = vi.fn();
  render(<MoonTimeline value={value} now={NOW} onChange={onChange} />);
  return {
    onChange,
    slider: screen.getByRole("slider", { name: "Moon time" }),
  };
}

describe("MoonTimeline", () => {
  it("exposes the instant as a slider value and text", () => {
    const { slider } = setup();
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Saturday 3 October at 13:00",
    );
    expect(slider).toHaveAttribute("aria-valuenow", String(NOW.getTime()));
    expect(Number(slider.getAttribute("aria-valuemin"))).toBeLessThan(
      NOW.getTime(),
    );
    expect(Number(slider.getAttribute("aria-valuemax"))).toBeGreaterThan(
      NOW.getTime(),
    );
  });

  it("steps an hour on arrows and a day with Shift and Page keys", async () => {
    const user = userEvent.setup();
    const { slider, onChange } = setup();
    slider.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(
      new Date(NOW.getTime() + HOUR_MS),
    );
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(
      new Date(NOW.getTime() - HOUR_MS),
    );
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onChange).toHaveBeenLastCalledWith(new Date(NOW.getTime() + DAY_MS));
    await user.keyboard("{PageDown}");
    expect(onChange).toHaveBeenLastCalledWith(new Date(NOW.getTime() - DAY_MS));
  });

  it("returns to now on Home and from the Now button", async () => {
    const user = userEvent.setup();
    const later = new Date(NOW.getTime() + 5 * HOUR_MS);
    const { slider, onChange } = setup(later);
    slider.focus();
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith(NOW);
    onChange.mockClear();
    await user.click(screen.getByRole("button", { name: "Now" }));
    expect(onChange).toHaveBeenCalledWith(NOW);
  });

  it("disables Now when already at now", () => {
    setup();
    expect(screen.getByRole("button", { name: "Now" })).toBeDisabled();
  });

  it("scrubs on horizontal wheel", () => {
    const { slider, onChange } = setup();
    fireEvent.wheel(slider, { deltaX: 16 });
    expect(onChange).toHaveBeenLastCalledWith(
      new Date(NOW.getTime() + 2 * HOUR_MS),
    );
  });

  it("labels today and draws day ticks", () => {
    setup();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Fri")).toBeInTheDocument();
  });
});
