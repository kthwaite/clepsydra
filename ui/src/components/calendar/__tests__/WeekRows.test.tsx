import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WeekRows } from "#/components/calendar/WeekRows";
import type { BirthdayOccurrence } from "#/lib/birthday";
import type { CalendarEntryLike } from "#/lib/calendar/bucket";
import { type DateKey, weekRows } from "#/lib/calendar/dates";
import { KIND_META } from "#/lib/kind";

vi.mock("#/components/codex/CLink", () => ({
  CLink: ({ path, children }: { path?: string; children: React.ReactNode }) => (
    <a href={`/pages/${path}`} data-path={path}>
      {children}
    </a>
  ),
}));

const byDay = new Map<DateKey, readonly CalendarEntryLike[]>([
  [
    "2026-09-29",
    [
      { path: "journals/2026-09-29.md", title: "29 Sep", kind: "JOURNAL" },
      { path: "notes/beer.md", title: "Tasting Beer", kind: "NOTE" },
    ],
  ],
]);

function renderRows(
  props: Partial<React.ComponentProps<typeof WeekRows>> = {},
) {
  const onDayActivate = vi.fn();
  const utils = render(
    <WeekRows
      rows={weekRows("2026-09-30", 2)}
      byDay={byDay}
      today="2026-09-30"
      onDayActivate={onDayActivate}
      {...props}
    />,
  );
  return { ...utils, onDayActivate };
}

const dayColumn = (container: HTMLElement, key: DateKey) => {
  const el = container.querySelector<HTMLElement>(`[data-date="${key}"]`);
  if (!el) throw new Error(`no day ${key}`);
  return el;
};

describe("WeekRows", () => {
  it("renders one labelled region per week with seven day columns", () => {
    const { container } = renderRows();
    const week40 = screen.getByRole("region", { name: "Week 40, 2026" });
    const week41 = screen.getByRole("region", { name: "Week 41, 2026" });
    expect(week40.querySelectorAll("[data-date]")).toHaveLength(7);
    expect(week41.querySelectorAll("[data-date]")).toHaveLength(7);
    expect(dayColumn(container, "2026-09-28")).toBeInTheDocument();
    expect(dayColumn(container, "2026-10-11")).toBeInTheDocument();
  });

  it("marks today", () => {
    const { container } = renderRows();
    expect(dayColumn(container, "2026-09-30")).toHaveAttribute("data-today");
    expect(dayColumn(container, "2026-09-29")).not.toHaveAttribute(
      "data-today",
    );
  });

  it("marks the active day", () => {
    const { container } = renderRows({ activeDate: "2026-09-29" });
    expect(dayColumn(container, "2026-09-29")).toHaveAttribute("data-active");
  });

  it("lists each day's titles as links to their paths, with a kind dot", () => {
    const { container } = renderRows();
    const day = dayColumn(container, "2026-09-29");
    const link = within(day).getByRole("link", { name: "Tasting Beer" });
    expect(link).toHaveAttribute("data-path", "notes/beer.md");
    const dot = link.querySelector<HTMLElement>("[data-kind-dot]");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot?.style.background).toBe(KIND_META.NOTE.color);
  });

  it("shows the count in the day button and activates the day", async () => {
    const user = userEvent.setup();
    const { onDayActivate } = renderRows();
    const button = screen.getByRole("button", { name: /29.*2 pages/ });
    await user.click(button);
    expect(onDayActivate).toHaveBeenCalledWith("2026-09-29");
  });

  it("caps inline titles and offers the rest through the day", async () => {
    const user = userEvent.setup();
    const many: CalendarEntryLike[] = Array.from({ length: 11 }, (_, i) => ({
      path: `notes/n${i}.md`,
      title: `Note ${String(i).padStart(2, "0")}`,
      kind: "NOTE",
    }));
    const { container, onDayActivate } = renderRows({
      byDay: new Map([["2026-10-01", many]]),
    });
    const day = dayColumn(container, "2026-10-01");
    expect(within(day).getAllByRole("link")).toHaveLength(8);
    await user.click(within(day).getByRole("button", { name: "3 more" }));
    expect(onDayActivate).toHaveBeenCalledWith("2026-10-01");
  });

  describe("birthdays", () => {
    const birthdaysByDay = new Map<DateKey, readonly BirthdayOccurrence[]>([
      [
        "2026-09-29",
        [{ path: "people/ada.md", title: "Ada", date: "2026-09-29", age: 43 }],
      ],
    ]);

    it("lists a day's birthdays first, linking to the person", () => {
      const { container } = renderRows({ birthdaysByDay });
      const day = dayColumn(container, "2026-09-29");
      const links = within(day).getAllByRole("link");
      expect(links[0]).toHaveTextContent("Ada — birthday, turns 43");
      expect(links[0]).toHaveAttribute("data-path", "people/ada.md");
      expect(links[0].querySelector("[data-birthday-marker]")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(links).toHaveLength(3);
    });

    it("names birthdays in the day button but counts only pages", () => {
      renderRows({ birthdaysByDay });
      const button = screen.getByRole("button", {
        name: /29.*2 pages, 1 birthday$/,
      });
      expect(button).toHaveTextContent(/2$/);
    });

    it("birthdays do not use up the inline cap", () => {
      const many: CalendarEntryLike[] = Array.from({ length: 8 }, (_, i) => ({
        path: `notes/n${i}.md`,
        title: `Note ${i}`,
        kind: "NOTE",
      }));
      const { container } = renderRows({
        byDay: new Map([["2026-09-29", many]]),
        birthdaysByDay,
      });
      const day = dayColumn(container, "2026-09-29");
      expect(within(day).getAllByRole("link")).toHaveLength(9);
      expect(within(day).queryByRole("button", { name: /more/ })).toBeNull();
    });
  });
});
