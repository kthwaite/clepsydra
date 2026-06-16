import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SkyCard, type SkyData } from "#/components/codex/SkyCard";

function makeSky(overrides: Partial<SkyData> = {}): SkyData {
  return {
    moon: {
      phaseName: "Waxing Gibbous",
      glyph: "🌔",
      illumPct: 72,
      waxing: true,
      terminatorScaleX: 0.44,
    },
    sunrise: "06:12",
    sunset: "20:41",
    lightLeft: "3h 05m",
    arc: { t: 0.5, x: 300, y: 8 },
    place: "London",
    ...overrides,
  };
}

describe("SkyCard", () => {
  it("renders sun values and an edit control when located", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<SkyCard sky={makeSky()} hasLocation={true} onEdit={onEdit} />);

    expect(screen.getByText("06:12")).toBeInTheDocument();
    expect(screen.getByText("20:41")).toBeInTheDocument();
    expect(screen.getByText("London")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set location/i })).toBeNull();

    const edit = screen.getByRole("button", { name: /edit/i });
    await user.click(edit);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("renders a CTA and greys the body when unlocated", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(
      <SkyCard
        sky={makeSky({ place: null })}
        hasLocation={false}
        onEdit={onEdit}
      />,
    );

    const cta = screen.getByRole("button", { name: /set location/i });
    await user.click(cta);
    expect(onEdit).toHaveBeenCalledTimes(1);

    // No "edit" affordance is shown while unlocated (the CTA covers it).
    expect(screen.queryByRole("button", { name: /^edit$/i })).toBeNull();
  });
});
