import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DayNotesList } from "#/components/calendar/DayNotesList";
import type { BirthdayOccurrence } from "#/lib/birthday";
import type { CalendarEntryLike } from "#/lib/calendar/bucket";
import { KIND_META } from "#/lib/kind";

vi.mock("#/components/codex/CLink", () => ({
  CLink: ({ path, children }: { path?: string; children: React.ReactNode }) => (
    <a href={`/pages/${path}`} data-path={path}>
      {children}
    </a>
  ),
}));

const entries: CalendarEntryLike[] = [
  { path: "notes/b.md", title: "Beta", kind: "NOTE" },
  { path: "recipes/soup.md", title: "Soup", kind: "RECIPE" },
  { path: "journals/2026-09-30.md", title: "30 Sep", kind: "JOURNAL" },
  { path: "notes/untitled.md", title: null, kind: "NOTE" },
];

function renderList(
  props: Partial<React.ComponentProps<typeof DayNotesList>> = {},
) {
  const onOpenJournal = vi.fn();
  render(
    <DayNotesList
      dateKey="2026-09-30"
      entries={entries}
      onOpenJournal={onOpenJournal}
      {...props}
    />,
  );
  return { onOpenJournal };
}

describe("DayNotesList", () => {
  it("heads the list with the long local date", () => {
    renderList();
    const expected = new Date(2026, 8, 30).toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    expect(screen.getByRole("heading", { name: expected })).toBeTruthy();
  });

  it("groups entries by kind in dayKinds order with journals first", () => {
    renderList();
    const names = screen
      .getAllByRole("list")
      .map((l) => l.getAttribute("aria-label"));
    expect(names).toEqual(["Journal", "Note", "Recipe"]);
    const notes = screen.getByRole("list", { name: "Note" });
    expect(within(notes).getAllByRole("link")).toHaveLength(2);
  });

  it("renders each entry as a link to its path, falling back to the path when untitled", () => {
    renderList();
    const soup = screen.getByRole("link", { name: "Soup" });
    expect(soup.getAttribute("data-path")).toBe("recipes/soup.md");
    const untitled = screen.getByRole("link", { name: "notes/untitled.md" });
    expect(untitled.getAttribute("data-path")).toBe("notes/untitled.md");
  });

  it("shows the empty message when there are no entries", () => {
    renderList({ entries: [] });
    expect(screen.getByText("Nothing created this day.")).toBeTruthy();
    expect(screen.queryAllByRole("list")).toHaveLength(0);
  });

  it("the journal action calls onOpenJournal", async () => {
    const user = userEvent.setup();
    const { onOpenJournal } = renderList({
      journalPath: "journals/2026-09-30.md",
    });
    await user.click(screen.getByRole("button", { name: "Open journal" }));
    expect(onOpenJournal).toHaveBeenCalledTimes(1);
  });

  it("labels the action Open journal when the day has a journal", () => {
    renderList({
      dateKey: "2026-09-12",
      today: "2026-09-30",
      journalPath: "journals/2026-09-12.md",
    });
    expect(screen.getByRole("button", { name: "Open journal" })).toBeTruthy();
  });

  it("labels the action Create journal for a past day without one", () => {
    renderList({ dateKey: "2026-09-12", today: "2026-09-30", entries: [] });
    expect(screen.getByRole("button", { name: "Create journal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open journal/ })).toBeNull();
  });

  it("labels the action Open journal for today even before it is written", () => {
    renderList({ dateKey: "2026-09-30", today: "2026-09-30", entries: [] });
    expect(screen.getByRole("button", { name: "Open journal" })).toBeTruthy();
  });

  it("while loading, shows a loading line instead of claiming the day is empty", () => {
    renderList({ entries: [], loading: true });
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(screen.queryByText("Nothing created this day.")).toBeNull();
  });

  it("colour dots are aria-hidden and use KIND_META colours", () => {
    const { container } = render(
      <DayNotesList
        dateKey="2026-09-30"
        entries={entries}
        onOpenJournal={() => {}}
      />,
    );
    const dots = container.querySelectorAll<HTMLElement>("[data-kind-dot]");
    expect(dots).toHaveLength(3);
    for (const dot of dots) {
      expect(dot.getAttribute("aria-hidden")).toBe("true");
    }
    expect(dots[0].style.background).toBe(KIND_META.JOURNAL.color);
  });

  describe("birthdays", () => {
    const birthdays: BirthdayOccurrence[] = [
      { path: "people/ada.md", title: "Ada", date: "2026-09-30", age: 43 },
      { path: "people/bob.md", title: null, date: "2026-09-30", age: null },
    ];

    it("lists a Birthdays group before the kind groups", () => {
      renderList({ birthdays });
      const names = screen
        .getAllByRole("list")
        .map((l) => l.getAttribute("aria-label"));
      expect(names).toEqual(["Birthdays", "Journal", "Note", "Recipe"]);
      expect(screen.getByText("Birthdays")).toBeTruthy();
    });

    it("links each birthday to the person page with its label", () => {
      renderList({ birthdays });
      const group = screen.getByRole("list", { name: "Birthdays" });
      const links = within(group).getAllByRole("link");
      expect(links.map((l) => l.textContent)).toEqual([
        "Ada — birthday, turns 43",
        "people/bob.md — birthday",
      ]);
      expect(links[0].getAttribute("data-path")).toBe("people/ada.md");
    });

    it("a day with only birthdays is not empty", () => {
      renderList({ entries: [], birthdays });
      expect(screen.queryByText("Nothing created this day.")).toBeNull();
      expect(screen.getAllByRole("list")).toHaveLength(1);
    });

    it("no birthdays, no group", () => {
      renderList({ birthdays: [] });
      expect(screen.queryByRole("list", { name: "Birthdays" })).toBeNull();
    });
  });

  it("uses the requested heading level", () => {
    renderList({ headingLevel: 4 });
    expect(screen.getByRole("heading", { level: 4 })).toBeTruthy();
  });
});
