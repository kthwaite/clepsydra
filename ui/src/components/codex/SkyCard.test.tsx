import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SkyCard } from "./SkyCard";
import type { SkyData } from "./sky";

const SKY: SkyData = {
  moon: {
    phaseName: "Waxing gibbous",
    glyph: "🌔",
    illumPct: 82,
    waxing: true,
    terminatorScaleX: 0.5,
  },
  sunrise: "06:58",
  sunriseIsTomorrow: false,
  sunset: "18:52",
  lightLeft: "8 h 10 m",
  arc: { t: 0.3, x: 120, y: 20 },
  place: "Harbour",
};

describe("SkyCard", () => {
  it("names the phase in serif and lists sun facts as a definition list", () => {
    render(<SkyCard sky={SKY} hasLocation onEdit={() => {}} />);
    expect(screen.getByText("Waxing gibbous")).toHaveClass("font-serif");
    const term = screen.getByText("Sunrise");
    expect(term.tagName).toBe("DT");
    expect(term).toHaveClass("text-mute");
    expect(screen.getByText("06:58").tagName).toBe("DD");
  });

  it("edits the location from a round icon button", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<SkyCard sky={SKY} hasLocation onEdit={onEdit} />);
    const edit = screen.getByRole("button", { name: "Edit location" });
    expect(edit).toHaveClass("rounded-full");
    await user.click(edit);
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("offers Set location when no location is saved", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<SkyCard sky={SKY} hasLocation={false} onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: "Set location" }));
    expect(onEdit).toHaveBeenCalledOnce();
  });
});
