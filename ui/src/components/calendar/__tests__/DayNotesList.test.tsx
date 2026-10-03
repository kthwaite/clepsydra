import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarTodoItem } from "#/api/calendar";
import { DayNotesList } from "#/components/calendar/DayNotesList";
import type { BirthdayOccurrence } from "#/lib/birthday";
import type { CalendarEntryLike } from "#/lib/calendar/bucket";
import { KIND_META } from "#/lib/kind";

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  patchTask: vi.fn(),
  toggleTodo: vi.fn(),
}));

vi.mock("#/api/tasks", () => ({
  useToggleTaskStatus: () => ({ mutate: mocks.toggleTodo, isPending: false }),
}));
vi.mock("#/api/board", () => ({
  usePatchTask: () => ({ mutate: mocks.patchTask, isPending: false }),
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => mocks.openTab }));

beforeEach(() => vi.clearAllMocks());

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
  describe("todos", () => {
    const todos: CalendarTodoItem[] = [
      {
        kind: "todo",
        content: "Buy hops",
        status: "todo",
        due: "2026-09-30",
        priority: "A",
        page_path: "notes/brew.md",
        page_title: "Brew Day",
        span_start: 4,
      },
      {
        kind: "todo",
        content: "Clean the fermenter",
        status: "done",
        due: "2026-09-30",
        page_path: "notes/brew.md",
        page_title: "Brew Day",
        span_start: 40,
      },
      {
        kind: "task",
        id: "01900000-0000-7000-8000-000000000001",
        code: "TSK-brave-finch",
        title: "Bottle the stout",
        status: "FIELD",
        priority: "P1",
        project: "brewing",
        due: "2026-09-30",
        path: "tasks/TSK-brave-finch.md",
      },
    ];
    const birthdays: BirthdayOccurrence[] = [
      { path: "people/ada.md", title: "Ada", date: "2026-09-30", age: 43 },
    ];

    it("lists a Todos group after birthdays and before the kind groups", () => {
      renderList({ birthdays, todos });
      const names = screen
        .getAllByRole("list")
        .map((l) => l.getAttribute("aria-label"));
      expect(names).toEqual([
        "Birthdays",
        "Todos",
        "Journal",
        "Note",
        "Recipe",
      ]);
      const group = screen.getByRole("list", { name: "Todos" });
      expect(within(group).getAllByRole("listitem")).toHaveLength(3);
    });

    it("toggles a checkbox todo to its next status", async () => {
      const user = userEvent.setup();
      renderList({ todos });
      await user.click(
        screen.getByRole("button", {
          name: "Mark Todo done: Buy hops (Brew Day)",
        }),
      );
      expect(mocks.toggleTodo).toHaveBeenCalledWith({
        pagePath: "notes/brew.md",
        spanStart: 4,
        status: "done",
      });
    });

    it("patches a TASK's status through its select", async () => {
      const user = userEvent.setup();
      renderList({ todos });
      const status = screen.getByRole("button", {
        name: /Status for TSK-brave-finch: Bottle the stout/,
      });
      expect(status).toHaveTextContent("In Progress");
      await user.click(status);
      await user.click(screen.getByRole("option", { name: "Done" }));
      expect(mocks.patchTask).toHaveBeenCalledWith({
        id: "01900000-0000-7000-8000-000000000001",
        patch: { status: "SEALED" },
      });
    });

    it("stacks a TASK row: title first, status select below", () => {
      renderList({ todos });
      const title = screen.getByText("Bottle the stout");
      const status = screen.getByRole("button", {
        name: /Status for TSK-brave-finch: Bottle the stout/,
      });
      expect(
        title.compareDocumentPosition(status) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("shows the priority and code badges, and opens each source page", async () => {
      const user = userEvent.setup();
      renderList({ todos });
      const group = screen.getByRole("list", { name: "Todos" });
      expect(within(group).getByText("A")).toBeInTheDocument();
      expect(within(group).getByText("TSK-brave-finch")).toBeInTheDocument();
      await user.click(
        within(group).getAllByRole("button", { name: "Brew Day" })[0],
      );
      await user.click(
        within(group).getByRole("button", {
          name: "tasks/TSK-brave-finch.md",
        }),
      );
      expect(mocks.openTab).toHaveBeenNthCalledWith(1, "page", "notes/brew.md");
      expect(mocks.openTab).toHaveBeenNthCalledWith(
        2,
        "page",
        "tasks/TSK-brave-finch.md",
      );
    });

    it("strikes through and dims done rows only", () => {
      renderList({ todos });
      const done = screen.getByText("Clean the fermenter");
      expect(done).toHaveClass("line-through");
      expect(done).toHaveClass("text-mute");
      expect(screen.getByText("Buy hops")).not.toHaveClass("line-through");
      expect(screen.getByText("Bottle the stout")).not.toHaveClass(
        "line-through",
      );
    });

    it("does not repeat the day as each row's due date", () => {
      renderList({ todos });
      const group = screen.getByRole("list", { name: "Todos" });
      expect(within(group).queryByText("2026-09-30")).toBeNull();
    });

    it("a day with only todos is not empty", () => {
      renderList({ entries: [], todos });
      expect(screen.queryByText("Nothing created this day.")).toBeNull();
      expect(screen.getAllByRole("list")).toHaveLength(1);
    });
  });
});
