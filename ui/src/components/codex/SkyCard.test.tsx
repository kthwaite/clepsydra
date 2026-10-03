import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SkyCard } from "./SkyCard";
import type { SkyData } from "./sky";

const SKY: SkyData = {
  instant: new Date("2026-10-22T12:00:00Z"),
  moon: {
    phaseName: "Waxing gibbous",
    glyph: "🌔",
    illumPct: 82,
    waxing: true,
    terminatorScaleX: 0.5,
    rise: "14:21",
    set: "01:07",
    nextFull: "in 23 days",
    distance: "384,400 km",
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

  it("lists moon rows after the sun rows, as a separate group", () => {
    render(<SkyCard sky={SKY} hasLocation onEdit={() => {}} />);
    for (const [k, v] of [
      ["Moonrise", "14:21"],
      ["Moonset", "01:07"],
      ["Next full", "in 23 days"],
      ["Distance", "384,400 km"],
    ]) {
      const term = screen.getByText(k);
      expect(term.tagName).toBe("DT");
      expect(term.nextElementSibling).toHaveTextContent(v);
    }
    const sunList = screen.getByText("Sunrise").closest("dl");
    const moonList = screen.getByText("Moonrise").closest("dl");
    expect(sunList).not.toBe(moonList);
    expect(moonList?.className).not.toMatch(/border/);
  });

  it("opens moon details from the disc", async () => {
    const onOpenMoon = vi.fn();
    const user = userEvent.setup();
    render(
      <SkyCard
        sky={SKY}
        hasLocation
        onEdit={() => {}}
        onOpenMoon={onOpenMoon}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Moon details" }));
    expect(onOpenMoon).toHaveBeenCalledOnce();
  });

  it("keeps the moon reachable above the Set location overlay", async () => {
    const onOpenMoon = vi.fn();
    const user = userEvent.setup();
    render(
      <SkyCard
        sky={SKY}
        hasLocation={false}
        onEdit={() => {}}
        onOpenMoon={onOpenMoon}
      />,
    );
    const moon = screen.getByRole("button", { name: "Moon details" });
    // The moon needs no location: it is neither dimmed nor inert, and it
    // stacks above the overlay that covers the sun facts.
    expect(moon.closest(".pointer-events-none")).toBeNull();
    expect(moon.closest(".opacity-40")).toBeNull();
    expect(moon.closest(".z-10")).not.toBeNull();
    await user.click(moon);
    expect(onOpenMoon).toHaveBeenCalledOnce();
    expect(
      screen.getByText("Sunrise").closest(".pointer-events-none"),
    ).not.toBeNull();
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
    // The prompt sits on its own backdrop so it never overlaps the dimmed facts.
    const prompt = screen.getByText(/Set your location/);
    expect(prompt.parentElement).toHaveClass("bg-ground/85");
    await user.click(screen.getByRole("button", { name: "Set location" }));
    expect(onEdit).toHaveBeenCalledOnce();
  });
});
