import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DayNotesList } from "#/components/calendar/DayNotesList";
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

  it("Open journal calls onOpenJournal; label reflects an existing journal", async () => {
    const user = userEvent.setup();
    const { onOpenJournal } = renderList({ entries: [] });
    await user.click(screen.getByRole("button", { name: "Open journal" }));
    expect(onOpenJournal).toHaveBeenCalledTimes(1);
  });

  it("labels the action as written when a journal exists", () => {
    renderList({ journalPath: "journals/2026-09-30.md" });
    expect(
      screen.getByRole("button", { name: "Open journal · written" }),
    ).toBeTruthy();
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

  it("uses the requested heading level", () => {
    renderList({ headingLevel: 4 });
    expect(screen.getByRole("heading", { level: 4 })).toBeTruthy();
  });
});
