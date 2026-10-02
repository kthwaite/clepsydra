import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  MonthCalendar,
  type MonthCalendarProps,
} from "#/components/calendar/MonthCalendar";
import type { BirthdayOccurrence } from "#/lib/birthday";
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
function Controlled({
  initialMonth = "2026-09-01",
  ...props
}: Partial<MonthCalendarProps> & { initialMonth?: DateKey }) {
  const [month, setMonth] = useState<DateKey>(initialMonth);
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

  it("page variant draws each day as a tonal tile with its count beside the date", () => {
    const { container } = renderCalendar({ variant: "page" });
    const face = day(container, "2026-09-15");
    expect(face.dataset.variant).toBe("page");
    expect(face.className).toMatch(/\bbg-sink\/40\b/);
    const count = face.querySelector<HTMLElement>("[data-day-count]");
    // The count shares the date's row, right after the date, inside the tile.
    expect(count?.previousElementSibling?.textContent).toBe("15");
    expect(count?.parentElement?.className).not.toMatch(/justify-between/);
  });

  it("page variant keeps outside-month tiles faint", () => {
    const { container } = renderCalendar({ variant: "page" });
    const outside = day(container, "2026-08-31");
    expect(outside).toHaveAttribute("data-outside");
    expect(outside.className).toMatch(/\btext-faint\b/);
    expect(outside.className).not.toMatch(/\bbg-sink\/40\b/);
  });

  it("page variant left-aligns weekday headings with the day content", () => {
    renderCalendar({ variant: "page" });
    const headers = screen.getAllByRole("columnheader", { hidden: true });
    for (const h of headers) {
      expect(h.className).toMatch(/\btext-left\b/);
      expect(h.className).not.toMatch(/\btext-center\b/);
    }
  });

  it("compact variant shows dots but no count text, and describes the count", () => {
    const { container } = renderCalendar({ variant: "compact", months: 3 });
    expect(container.querySelector("[data-day-count]")).toBeNull();
    const face = day(container, "2026-09-15");
    expect(face.dataset.variant).toBe("compact");
    expect(face.querySelectorAll("[data-kind-dot]").length).toBeGreaterThan(0);
    expect(dayButton(15)).toHaveAccessibleDescription("6 notes");
  });

  it("compact variant rows are denser than page rows and match the week column", () => {
    const { container } = renderCalendar({ variant: "compact" });
    const cell = dayButton(15);
    expect(cell.className).toMatch(/\bh-10\b/);
    expect(cell.className).not.toMatch(/\bh-24\b/);
    for (const n of container.querySelectorAll("[data-week-number]")) {
      expect(n.className).toMatch(/\bh-10\b/);
    }
  });

  it("fill stretches page rows to the grid's height, with a floor", () => {
    const { container } = renderCalendar({ variant: "page", fill: true });
    const grid = container.querySelector<HTMLElement>(
      "[class*='container-type:size']",
    );
    // September 2026 spans five ISO weeks (36–40).
    expect(grid?.style.getPropertyValue("--cal-row")).toBe(
      "max(6rem, calc((100cqh - 1.75rem) / 5))",
    );
    // jsdom folds the calc: 1.75rem header + 5 × 6rem rows.
    expect(grid?.style.minHeight).toBe("calc(31.75rem)");
    expect(dayButton(15).className).toMatch(/h-\[var\(--cal-row\)\]/);
    for (const n of container.querySelectorAll("[data-week-number]")) {
      expect(n.className).toMatch(/h-\[var\(--cal-row\)\]/);
    }
  });

  it("fill does nothing with several months", () => {
    const { container } = renderCalendar({
      variant: "compact",
      months: 3,
      fill: true,
    });
    expect(
      container.querySelector("[class*='container-type:size']"),
    ).toBeNull();
    expect(dayButton(15).className).toMatch(/\bh-10\b/);
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

  it("describes each day's note count to assistive tech", () => {
    renderCalendar({
      byDay: new Map<DateKey, readonly CalendarEntryLike[]>([
        ["2026-09-15", busyDay],
        ["2026-09-16", [entry("x", "NOTE")]],
      ]),
    });
    expect(dayButton(15)).toHaveAccessibleDescription("6 notes");
    expect(dayButton(16)).toHaveAccessibleDescription("1 note");
    expect(dayButton(14)).not.toHaveAttribute("aria-describedby");
  });

  it("page variant describes the note count too", () => {
    renderCalendar({ variant: "page" });
    expect(dayButton(15)).toHaveAccessibleDescription("6 notes");
  });

  it("drops the description when a day's notes go away", () => {
    const { rerender } = renderCalendar();
    expect(dayButton(15)).toHaveAccessibleDescription("6 notes");
    rerender(
      <MonthCalendar
        visibleMonth="2026-09-01"
        onVisibleMonthChange={() => {}}
        byDay={new Map()}
        today="2026-09-30"
        onDayActivate={() => {}}
        variant="rail"
      />,
    );
    expect(dayButton(15)).not.toHaveAttribute("aria-describedby");
  });

  describe("birthdays", () => {
    const born = (path: string, date: DateKey): BirthdayOccurrence => ({
      path,
      title: path,
      date,
      age: 40,
    });
    const birthdaysByDay = new Map<DateKey, readonly BirthdayOccurrence[]>([
      ["2026-09-15", [born("ada", "2026-09-15")]],
      ["2026-09-20", [born("bob", "2026-09-20"), born("cy", "2026-09-20")]],
      ["2026-10-02", [born("di", "2026-10-02")]],
    ]);
    const marker = (container: HTMLElement, key: DateKey) =>
      day(container, key).querySelector("[data-birthday-marker]");

    it.each(["rail", "compact", "page"] as const)(
      "%s variant shows a hidden cake marker beside the kind dots",
      (variant) => {
        const { container } = renderCalendar({ variant, birthdaysByDay });
        const cake = marker(container, "2026-09-15");
        expect(cake).not.toBeNull();
        expect(cake?.tagName.toLowerCase()).toBe("svg");
        expect(cake?.closest("[aria-hidden='true']")).not.toBeNull();
        // Beside the dots: same marker row.
        expect(
          cake?.parentElement?.querySelector("[data-kind-dot]"),
        ).not.toBeNull();
        expect(marker(container, "2026-09-14")).toBeNull();
      },
    );

    it("shows one marker however many birthdays fall on a day", () => {
      const { container } = renderCalendar({ birthdaysByDay });
      expect(
        day(container, "2026-09-20").querySelectorAll("[data-birthday-marker]"),
      ).toHaveLength(1);
    });

    it("dims the marker on outside-month days", () => {
      const { container } = renderCalendar({ birthdaysByDay });
      const outside = marker(container, "2026-10-02");
      expect(outside?.closest(".opacity-50")).not.toBeNull();
      expect(
        marker(container, "2026-09-20")?.closest(".opacity-50"),
      ).toBeNull();
    });

    it("folds birthdays into the day's description", () => {
      renderCalendar({ birthdaysByDay });
      expect(dayButton(15)).toHaveAccessibleDescription("6 notes, 1 birthday");
      expect(dayButton(20)).toHaveAccessibleDescription("2 birthdays");
      expect(dayButton(14)).not.toHaveAttribute("aria-describedby");
    });

    it("page variant counts notes only", () => {
      const { container } = renderCalendar({
        variant: "page",
        birthdaysByDay,
      });
      expect(
        day(container, "2026-09-20").querySelector("[data-day-count]"),
      ).toBeNull();
    });
  });

  it("months={3} passes the in-month cell of a date shown in two grids", async () => {
    const user = userEvent.setup();
    const { onDayActivate, rerender } = renderCalendar({
      months: 3,
      variant: "page",
    });
    // A re-render re-runs every cell's ref; the passed cell must still be
    // October 1 in October's grid, not the disabled copy trailing September.
    rerender(
      <MonthCalendar
        visibleMonth="2026-09-01"
        onVisibleMonthChange={() => {}}
        byDay={new Map(byDay)}
        today="2026-09-30"
        onDayActivate={onDayActivate}
        variant="page"
        months={3}
      />,
    );
    const grids = screen.getAllByRole("grid");
    const trailing = within(grids[0]).getByRole("button", {
      name: /October 1, 2026/,
    });
    expect(trailing).toHaveAttribute("aria-disabled", "true");
    const inOctGrid = within(grids[1]).getByRole("button", {
      name: /October 1, 2026/,
    });
    await user.click(inOctGrid);
    const [key, cell] = onDayActivate.mock.lastCall ?? [];
    expect(key).toBe("2026-10-01");
    expect(cell.isConnected).toBe(true);
    expect(cell.contains(inOctGrid)).toBe(true);
  });

  it("months={3} passes a live cell after paging", async () => {
    const user = userEvent.setup();
    const onDayActivate = vi.fn();
    render(
      <Controlled months={3} variant="page" onDayActivate={onDayActivate} />,
    );
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(
      screen.getByRole("heading", { name: /^October\s–\sDecember 2026$/ }),
    ).toBeTruthy();
    const [first] = screen.getAllByRole("grid");
    const oct1 = within(first).getByRole("button", { name: /October 1, 2026/ });
    await user.click(oct1);
    const [key, cell] = onDayActivate.mock.lastCall ?? [];
    expect(key).toBe("2026-10-01");
    expect(cell.isConnected).toBe(true);
    expect(cell.contains(oct1)).toBe(true);
  });

  it("months={3} mounts with visibleMonth in the first grid", () => {
    const { container } = renderCalendar({
      months: 3,
      variant: "page",
      visibleMonth: "2026-10-01",
    });
    expect(
      screen.getByRole("heading", { name: /^October\s–\sDecember 2026$/ }),
    ).toBeTruthy();
    const [first] = screen.getAllByRole("grid");
    const oct15 = within(first).getByRole("button", {
      name: /October 15, 2026/,
    });
    expect(oct15).toBeTruthy();
    const firstWeeks = container
      .querySelector("[data-week-column]")
      ?.querySelectorAll("[data-week-number]");
    expect(firstWeeks?.[0]?.textContent).toBe("40");
  });

  describe("overflow days", () => {
    const mayProps = {
      byDay,
      today: "2026-09-30",
      variant: "page" as const,
    };

    it("single month: clicking a leading day jumps to its month and focuses it", async () => {
      const user = userEvent.setup();
      const onVisibleMonthChange = vi.fn();
      const onDayActivate = vi.fn();
      const { container, rerender } = render(
        <MonthCalendar
          visibleMonth="2026-05-01"
          onVisibleMonthChange={onVisibleMonthChange}
          onDayActivate={onDayActivate}
          {...mayProps}
        />,
      );
      await user.click(day(container, "2026-04-27"));
      expect(onVisibleMonthChange).toHaveBeenCalledTimes(1);
      const [requested] = onVisibleMonthChange.mock.calls[0];
      expect(requested.slice(0, 7)).toBe("2026-04");
      rerender(
        <MonthCalendar
          visibleMonth={requested}
          onVisibleMonthChange={onVisibleMonthChange}
          onDayActivate={onDayActivate}
          {...mayProps}
        />,
      );
      expect(screen.getByRole("heading", { name: "April 2026" })).toBeTruthy();
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(
        /April 27, 2026/,
      );
      expect(onDayActivate).not.toHaveBeenCalled();
    });

    it("single month: clicking a trailing day jumps to its month and focuses it", async () => {
      const user = userEvent.setup();
      const onDayActivate = vi.fn();
      const { container } = render(
        <Controlled onDayActivate={onDayActivate} {...mayProps} />,
      );
      // September 2026's grid trails into October 1-4.
      await user.click(day(container, "2026-10-02"));
      expect(
        screen.getByRole("heading", { name: "October 2026" }),
      ).toBeTruthy();
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(
        /October 2, 2026/,
      );
      expect(onDayActivate).not.toHaveBeenCalled();
    });

    it("outside days that navigate show a pointer, not the disabled cursor", () => {
      const { container } = renderCalendar({ visibleMonth: "2026-05-01" });
      const cell = day(container, "2026-04-27").closest<HTMLElement>(
        '[role="button"]',
      );
      expect(cell?.className).toMatch(/\bcursor-pointer\b/);
      expect(cell?.className).not.toMatch(/data-\[disabled\]:cursor-default/);
    });

    it("prev/next remounts do not steal focus", async () => {
      const user = userEvent.setup();
      render(<Controlled />);
      const next = screen.getByRole("button", { name: "Next month" });
      await user.click(next);
      expect(
        screen.getByRole("heading", { name: "October 2026" }),
      ).toBeTruthy();
      expect(document.activeElement).toBe(next);
    });

    it("a parent month change after an overflow jump does not re-focus a day", async () => {
      const user = userEvent.setup();
      const { container } = render(<Controlled />);
      await user.click(day(container, "2026-08-31"));
      expect(screen.getByRole("heading", { name: "August 2026" })).toBeTruthy();
      const next = screen.getByRole("button", { name: "Next month" });
      await user.click(next);
      expect(
        screen.getByRole("heading", { name: "September 2026" }),
      ).toBeTruthy();
      expect(document.activeElement).toBe(next);
    });

    it("months={3}: an outside copy of a visible date activates the in-month cell", async () => {
      const user = userEvent.setup();
      const onDayActivate = vi.fn();
      const onVisibleMonthChange = vi.fn();
      render(
        <MonthCalendar
          visibleMonth="2026-09-01"
          onVisibleMonthChange={onVisibleMonthChange}
          onDayActivate={onDayActivate}
          months={3}
          {...mayProps}
        />,
      );
      const grids = screen.getAllByRole("grid");
      const trailing = within(grids[0]).getByRole("button", {
        name: /October 1, 2026/,
      });
      await user.click(trailing);
      expect(onVisibleMonthChange).not.toHaveBeenCalled();
      const [key, cell] = onDayActivate.mock.lastCall ?? [];
      expect(key).toBe("2026-10-01");
      const inOctGrid = within(grids[1]).getByRole("button", {
        name: /October 1, 2026/,
      });
      expect(cell.contains(inOctGrid)).toBe(true);
    });

    it("months={3}: a date past the last grid shifts the view by one month and focuses it", async () => {
      const user = userEvent.setup();
      const onDayActivate = vi.fn();
      render(
        <Controlled months={3} onDayActivate={onDayActivate} {...mayProps} />,
      );
      // September–November 2026; November's grid trails into December.
      const grids = screen.getAllByRole("grid");
      const dec1 = within(grids[2]).getByRole("button", {
        name: /December 1, 2026/,
      });
      await user.click(dec1);
      expect(
        screen.getByRole("heading", { name: /^October\s–\sDecember 2026$/ }),
      ).toBeTruthy();
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute("aria-label")).toMatch(/December 1, 2026/);
      expect(
        within(screen.getAllByRole("grid")[2]).getByRole("button", {
          name: /December 1, 2026/,
        }),
      ).toBe(active);
      expect(onDayActivate).not.toHaveBeenCalled();
    });

    it("months={3}: a date before the first grid shifts the view back by one month", async () => {
      const user = userEvent.setup();
      const { container } = render(<Controlled months={3} {...mayProps} />);
      await user.click(day(container, "2026-08-31"));
      expect(
        screen.getByRole("heading", { name: /^August\s–\sOctober 2026$/ }),
      ).toBeTruthy();
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(
        /August 31, 2026/,
      );
    });
  });

  it("renders headerExtra in the header", () => {
    renderCalendar({ headerExtra: <span>Mode switch</span> });
    expect(screen.getByText("Mode switch")).toBeTruthy();
  });
});
