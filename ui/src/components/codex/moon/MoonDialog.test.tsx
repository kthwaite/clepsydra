import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// three.js stays out of jsdom: the lazy globe shows its fallback.
vi.mock("./LazyMoonGlobe", () => ({
  LazyMoonGlobe: ({ fallback }: { fallback: ReactNode }) => (
    <div data-testid="moon-globe">{fallback}</div>
  ),
}));

import { DAY_MS, formatMoonInstant } from "./timeline";

const { MoonDialog } = await import("./MoonDialog");

const NOW = new Date(2026, 9, 3, 13);

function setup(location: { latitude: number; longitude: number } | null) {
  const onOpenChange = vi.fn();
  const view = render(
    <MoonDialog
      isOpen
      onOpenChange={onOpenChange}
      now={NOW}
      location={location}
    />,
  );
  return { onOpenChange, ...view };
}

function stat(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: "dt" });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no value: ${label}`);
  return value;
}

describe("MoonDialog", () => {
  it("is titled Moon and shows the globe, phase and instant", () => {
    setup(null);
    const dialog = screen.getByRole("dialog", { name: "Moon" });
    expect(within(dialog).getByTestId("moon-globe")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Saturday 3 October at 13:00"),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("slider", { name: "Moon time" }));
    expect(
      within(dialog).getByRole("heading", { name: "October 2026" }),
    ).toBeInTheDocument();
  });

  it("lists the stats; rise and set need a location", () => {
    setup(null);
    expect(stat("Illumination")).toHaveTextContent(/^\d{1,3}%$/);
    expect(stat("Moonrise")).toHaveTextContent("—");
    expect(stat("Moonset")).toHaveTextContent("—");
    expect(stat("Next full moon")).toHaveTextContent(/^in \d+ days$/);
    expect(stat("Next new moon")).toHaveTextContent(/^in \d+ days$/);
    expect(stat("Distance")).toHaveTextContent(/^\d{3},\d{3} km$/);
  });

  it("shows rise and set times with a location", () => {
    setup({ latitude: 51.5, longitude: -0.12 });
    const times = [stat("Moonrise"), stat("Moonset")].map((e) => e.textContent);
    expect(times.some((t) => /^\d{2}:\d{2}$/.test(t ?? ""))).toBe(true);
  });

  it("advances the heading by an hour on ArrowRight", async () => {
    const user = userEvent.setup();
    setup(null);
    screen.getByRole("slider", { name: "Moon time" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("Saturday 3 October at 14:00")).toBeInTheDocument();
  });

  it("jumps to a calendar day at the same time of day; Now resets", async () => {
    const user = userEvent.setup();
    setup(null);
    await user.click(
      screen.getByRole("button", { name: /^Monday 26 October/ }),
    );
    expect(screen.getByText("Monday 26 October at 13:00")).toBeInTheDocument();
    expect(stat("Illumination")).toHaveTextContent(/^(9[89]|100)%$/);
    expect(
      screen.getByRole("button", { name: /^Monday 26 October/ }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Now" }));
    expect(screen.getByText("Saturday 3 October at 13:00")).toBeInTheDocument();
  });

  it("follows a scrub into the next month, but paging only moves the grid", async () => {
    const user = userEvent.setup();
    setup(null);
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { name: "November 2026" }));
    expect(screen.getByText("Saturday 3 October at 13:00")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await user.click(
      screen.getByRole("button", { name: /^Saturday 31 October/ }),
    );
    const slider = screen.getByRole("slider", { name: "Moon time" });
    slider.focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    // Shift+→ steps 24 h of real time, so a DST change on 1 November
    // (e.g. US zones) lands at 12:00; derive the label in the runner's zone.
    const next = new Date(new Date(2026, 9, 31, 13).getTime() + DAY_MS);
    expect(screen.getByText(formatMoonInstant(next))).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "November 2026" }));
  });
});
