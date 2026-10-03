import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MoonCalendar } from "./MoonCalendar";

const OCT = { year: 2026, monthIndex0: 9 };
const TODAY = new Date(2026, 9, 3, 13);

function setup(selected = TODAY) {
  const onSelectDay = vi.fn();
  const onMonthChange = vi.fn();
  render(
    <MoonCalendar
      month={OCT}
      onMonthChange={onMonthChange}
      selected={selected}
      today={TODAY}
      onSelectDay={onSelectDay}
    />,
  );
  return { onSelectDay, onMonthChange };
}

describe("MoonCalendar", () => {
  it("titles the month and lays out 31 day buttons", () => {
    setup();
    expect(screen.getByRole("heading", { name: "October 2026" })).toHaveClass(
      "font-serif",
    );
    const group = screen.getByRole("group", { name: "October 2026" });
    expect(within(group).getAllByRole("button")).toHaveLength(31);
    // Thursday 1st sits after three blanks.
    expect(group.children[3]).toHaveAccessibleName(/^Thursday 1 October/);
  });

  it("names the 10 October cell as a new moon and draws a glyph", () => {
    setup();
    const cell = screen.getByRole("button", {
      name: "Saturday 10 October, New moon",
    });
    expect(within(cell).getByTestId("phase-glyph")).toBeInTheDocument();
  });

  it("marks the selected day pressed and today in accent", () => {
    setup(new Date(2026, 9, 26, 9));
    expect(
      screen.getByRole("button", { name: /^Monday 26 October/ }),
    ).toHaveAttribute("aria-pressed", "true");
    const today = screen.getByRole("button", { name: /^Saturday 3 October/ });
    expect(today).toHaveAttribute("aria-pressed", "false");
    expect(today).toHaveClass("text-accent");
  });

  it("lists the month's quarter events by date", () => {
    setup();
    const terms = screen.getAllByRole("term").map((t) => t.textContent);
    expect(terms).toEqual([
      "Last quarter",
      "New moon",
      "First quarter",
      "Full moon",
    ]);
    expect(screen.getByText("Sat 10 Oct")).toBeInTheDocument();
    expect(screen.getByText("Mon 26 Oct")).toBeInTheDocument();
  });

  it("selects a day on click", async () => {
    const user = userEvent.setup();
    const { onSelectDay } = setup();
    await user.click(
      screen.getByRole("button", { name: /^Saturday 10 October/ }),
    );
    expect(onSelectDay).toHaveBeenCalledWith(new Date(2026, 9, 10, 12));
  });

  it("pages months", async () => {
    const user = userEvent.setup();
    const { onMonthChange } = setup();
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(onMonthChange).toHaveBeenCalledWith({ year: 2026, monthIndex0: 10 });
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(onMonthChange).toHaveBeenLastCalledWith({
      year: 2026,
      monthIndex0: 8,
    });
  });
});
