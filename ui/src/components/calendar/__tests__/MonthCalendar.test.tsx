import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  MonthCalendar,
  type MonthCalendarProps,
} from "#/components/calendar/MonthCalendar";
import type { CalendarEntryLike } from "#/lib/calendar/bucket";
import type { DateKey } from "#/lib/calendar/dates";
import type { Kind } from "#/lib/kind";

const entry = (path: string, kind: Kind): CalendarEntryLike => ({
  path,
  title: path,
  kind,
});

const busyDay: CalendarEntryLike[] = [
  entry("a", "NOTE"),
  entry("b", "NOTE"),
  entry("c", "JOURNAL"),
  entry("d", "RECIPE"),
  entry("e", "MEETING"),
  entry("f", "PERSON"),
];

const byDay = new Map<DateKey, readonly CalendarEntryLike[]>([
  ["2026-09-15", busyDay],
]);

function renderCalendar(props: Partial<MonthCalendarProps> = {}) {
  const onDayActivate = vi.fn();
  const onVisibleMonthChange = vi.fn();
  const utils = render(
    <MonthCalendar
      visibleMonth="2026-09-01"
      onVisibleMonthChange={onVisibleMonthChange}
      byDay={byDay}
      today="2026-09-30"
      onDayActivate={onDayActivate}
      variant="rail"
      {...props}
    />,
  );
  return { ...utils, onDayActivate, onVisibleMonthChange };
}

/** Parent that follows the component's month requests, like the rail does. */
function Controlled(props: Partial<MonthCalendarProps>) {
  const [month, setMonth] = useState<DateKey>("2026-09-01");
  return (
    <MonthCalendar
      visibleMonth={month}
      onVisibleMonthChange={setMonth}
      byDay={byDay}
      today="2026-09-30"
      onDayActivate={() => {}}
      variant="rail"
      {...props}
    />
  );
}

const day = (container: HTMLElement, key: DateKey) => {
  const el = container.querySelector<HTMLElement>(`[data-date="${key}"]`);
  if (!el) throw new Error(`no cell for ${key}`);
  return el;
};

const dayButton = (n: number) =>
  screen.getByRole("button", { name: new RegExp(`September ${n}, 2026`) });

describe("MonthCalendar", () => {
  it("renders Monday-first weekday headers", () => {
    renderCalendar();
    // RAC hides the weekday row from assistive tech; each day's label names
    // its weekday.
    const headers = screen.getAllByRole("columnheader", { hidden: true });
    expect(headers).toHaveLength(7);
    expect(headers[0].textContent).toMatch(/^M/);
    expect(headers[6].textContent).toMatch(/^S/);
  });

  it("titles the header with the visible month and year", () => {
    renderCalendar();
    expect(
      screen.getByRole("heading", { name: "September 2026" }),
    ).toBeTruthy();
  });

  it("renders one week number per grid row, aligned with rows", () => {
    const { container } = renderCalendar();
    const weeks = [...container.querySelectorAll("[data-week-number]")].map(
      (el) => el.textContent,
    );
    expect(weeks).toEqual(["36", "37", "38", "39", "40"]);
    // The aria-hidden weekday header row is not counted.
    expect(screen.getAllByRole("row")).toHaveLength(weeks.length);
  });

  it("shows one dot per distinct kind, capped at four", () => {
    const { container } = renderCalendar();
    const cell = day(container, "2026-09-15");
    const dots = cell.querySelectorAll("[data-kind-dot]");
    expect(dots).toHaveLength(4);
    expect(
      cell.querySelector("[data-kind-dot]")?.getAttribute("data-kind"),
    ).toBe("JOURNAL");
    expect(
      day(container, "2026-09-14").querySelectorAll("[data-kind-dot]"),
    ).toHaveLength(0);
  });

  it("marks today, the selected date and the active date", () => {
    const { container } = renderCalendar({
      selectedDate: "2026-09-15",
      activeDate: "2026-09-20",
    });
    expect(day(container, "2026-09-30").hasAttribute("data-today")).toBe(true);
    expect(day(container, "2026-09-29").hasAttribute("data-today")).toBe(false);
    expect(day(container, "2026-09-15").hasAttribute("data-selected")).toBe(
      true,
    );
    expect(day(container, "2026-09-20").hasAttribute("data-active")).toBe(true);
    expect(day(container, "2026-09-15").hasAttribute("data-active")).toBe(
      false,
    );
  });

  it("marks days outside the month", () => {
    const { container } = renderCalendar();
    expect(day(container, "2026-08-31").hasAttribute("data-outside")).toBe(
      true,
    );
    expect(day(container, "2026-09-01").hasAttribute("data-outside")).toBe(
      false,
    );
  });

  it("pressing a day calls onDayActivate with its key and cell, including re-pressing the same day", async () => {
    const user = userEvent.setup();
    const { onDayActivate } = renderCalendar();
    await user.click(dayButton(15));
    await user.click(dayButton(15));
    expect(onDayActivate).toHaveBeenCalledTimes(2);
    const [key, cell] = onDayActivate.mock.calls[1];
    expect(key).toBe("2026-09-15");
    expect(cell).toBeInstanceOf(HTMLElement);
    expect(cell.contains(dayButton(15))).toBe(true);
  });

  it("prev/next/Today change the visible month", async () => {
    const user = userEvent.setup();
    const { onVisibleMonthChange } = renderCalendar({
      visibleMonth: "2026-07-01",
    });
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(onVisibleMonthChange).toHaveBeenLastCalledWith("2026-08-01");
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(onVisibleMonthChange).toHaveBeenLastCalledWith("2026-06-01");
    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(onVisibleMonthChange).toHaveBeenLastCalledWith("2026-09-30");
  });

  it("follows a new visibleMonth from the parent", () => {
    const { container, rerender } = renderCalendar();
    rerender(
      <MonthCalendar
        visibleMonth="2026-11-01"
        onVisibleMonthChange={() => {}}
        byDay={byDay}
        today="2026-09-30"
        onDayActivate={() => {}}
        variant="rail"
      />,
    );
    expect(screen.getByRole("heading", { name: "November 2026" })).toBeTruthy();
    expect(container.querySelector('[data-date="2026-11-15"]')).toBeTruthy();
  });

  it("keyboard: ArrowRight moves focus to the next day", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    act(() => dayButton(15).focus());
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(dayButton(16));
  });

  it("keyboard: PageDown requests the next month", async () => {
    const user = userEvent.setup();
    const { onVisibleMonthChange } = renderCalendar();
    act(() => dayButton(15).focus());
    await user.keyboard("{PageDown}");
    expect(onVisibleMonthChange).toHaveBeenLastCalledWith("2026-10-01");
  });

  it("keyboard paging through a controlled parent keeps the grid and week numbers in step", async () => {
    const user = userEvent.setup();
    const { container } = render(<Controlled />);
    act(() => dayButton(15).focus());
    await user.keyboard("{PageDown}");
    expect(screen.getByRole("heading", { name: "October 2026" })).toBeTruthy();
    const weeks = [...container.querySelectorAll("[data-week-number]")].map(
      (el) => el.textContent,
    );
    expect(weeks).toEqual(["40", "41", "42", "43", "44"]);
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(
      /October 15, 2026/,
    );
  });

  it("page variant shows the per-day count", () => {
    const { container } = renderCalendar({ variant: "page" });
    expect(
      day(container, "2026-09-15").querySelector("[data-day-count]")
        ?.textContent,
    ).toBe("6");
    expect(
      day(container, "2026-09-14").querySelector("[data-day-count]"),
    ).toBeNull();
  });

  it("rail variant shows no count", () => {
    const { container } = renderCalendar();
    expect(container.querySelector("[data-day-count]")).toBeNull();
  });

  it("months={3} renders three grids with their own week-number columns", () => {
    const { container } = renderCalendar({ months: 3, variant: "page" });
    expect(screen.getAllByRole("grid")).toHaveLength(3);
    expect(container.querySelectorAll("[data-week-column]")).toHaveLength(3);
    expect(
      // formatRange puts thin spaces around the dash.
      screen.getByRole("heading", { name: /^September\s–\sNovember 2026$/ }),
    ).toBeTruthy();
  });

  it("months={3} puts a new visibleMonth first, even when already visible", () => {
    const props = {
      onVisibleMonthChange: () => {},
      byDay,
      today: "2026-09-30",
      onDayActivate: () => {},
      variant: "page" as const,
      months: 3,
    };
    const { container, rerender } = render(
      <MonthCalendar visibleMonth="2026-09-01" {...props} />,
    );
    rerender(<MonthCalendar visibleMonth="2026-10-01" {...props} />);
    expect(
      screen.getByRole("heading", { name: /^October\s–\sDecember 2026$/ }),
    ).toBeTruthy();
    const firstWeeks = container
      .querySelector("[data-week-column]")
      ?.querySelectorAll("[data-week-number]");
    expect(firstWeeks?.[0]?.textContent).toBe("40");
  });

  it("renders headerExtra in the header", () => {
    renderCalendar({ headerExtra: <span>Mode switch</span> });
    expect(screen.getByText("Mode switch")).toBeTruthy();
  });
});
