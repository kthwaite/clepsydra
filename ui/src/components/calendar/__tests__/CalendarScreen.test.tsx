import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CalendarBirthday,
  CalendarEntry,
  CalendarTodoItem,
} from "#/api/calendar";
import { CalendarScreen } from "#/components/calendar/CalendarScreen";
import { monthGridRange } from "#/lib/calendar/dates";
import type { CalendarViewSearch } from "#/lib/calendar/search";
import { EMPTY_FILTER_STATE, type FilterState } from "#/lib/filters/model";

const mocks = vi.hoisted(() => ({
  entries: vi.fn(),
  openJournal: vi.fn(),
  toggleTodo: vi.fn(),
}));

vi.mock("#/api/calendar", () => ({ useCalendarEntries: mocks.entries }));
vi.mock("#/api/index", () => ({
  useTags: () => ({ data: [{ tag: "wine", count: 2, computed_count: 0 }] }),
}));
vi.mock("#/lib/useProjects", () => ({
  useProjectValues: () => ["clepsydra"],
}));
vi.mock("#/api/tasks", () => ({
  useToggleTaskStatus: () => ({ mutate: mocks.toggleTodo, isPending: false }),
}));
vi.mock("#/api/board", () => ({
  usePatchTask: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/hooks/useOpenJournalForDate", () => ({
  useOpenJournalForDate: () => mocks.openJournal,
}));
vi.mock("#/components/codex/CLink", () => ({
  CLink: ({ path, children }: { path?: string; children: React.ReactNode }) => (
    <a href={`/pages/${path}`} data-path={path}>
      {children}
    </a>
  ),
}));

const at = (day: string, hour = 12) =>
  new Date(`${day}T${String(hour).padStart(2, "0")}:00:00`).toISOString();

const ENTRIES: CalendarEntry[] = [
  {
    path: "notes/a.md",
    title: "Alpha",
    kind: "NOTE",
    created_at: at("2026-09-15"),
  },
  {
    path: "notes/b.md",
    title: "Bravo",
    kind: "NOTE",
    created_at: at("2026-09-15", 9),
  },
  {
    path: "journals/2026-09-15.md",
    title: "15 Sep",
    kind: "JOURNAL",
    journal_date: "2026-09-15",
    created_at: at("2026-09-16"),
  },
  {
    path: "notes/beer.md",
    title: "Tasting Beer",
    kind: "NOTE",
    created_at: at("2026-09-29"),
  },
];

function queryState(
  overrides: Partial<{
    entries: CalendarEntry[];
    birthdays: CalendarBirthday[];
    todos: CalendarTodoItem[];
    truncated: boolean;
    isLoading: boolean;
    isError: boolean;
  }> = {},
) {
  const {
    entries = ENTRIES,
    birthdays = [],
    todos = [],
    truncated = false,
    ...rest
  } = overrides;
  return {
    data: { entries, birthdays, todos, truncated },
    isLoading: false,
    isError: false,
    ...rest,
  };
}

function renderScreen(
  view: Partial<CalendarViewSearch> = {},
  filterState: FilterState = EMPTY_FILTER_STATE,
) {
  const onViewChange = vi.fn();
  const onFilterChange = vi.fn();
  const utils = render(
    <CalendarScreen
      view={{ mode: "month", span: 1, ...view }}
      filterState={filterState}
      onViewChange={onViewChange}
      onFilterChange={onFilterChange}
    />,
  );
  return { ...utils, onViewChange, onFilterChange };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 30, 10, 0));
  mocks.entries.mockReset();
  mocks.entries.mockReturnValue(queryState());
  mocks.openJournal.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CalendarScreen", () => {
  it("heads the screen with Calendar", () => {
    renderScreen();
    expect(
      screen.getByRole("heading", { level: 1, name: "Calendar" }),
    ).toBeInTheDocument();
  });

  it("puts filters and view controls on the month title row", () => {
    renderScreen();
    const title = screen.getByRole("heading", {
      level: 3,
      name: "September 2026",
    });
    const row = title.parentElement as HTMLElement;
    expect(within(row).getByRole("button", { name: "Kind" })).toBeVisible();
    expect(within(row).getByRole("radiogroup", { name: "Mode" })).toBeVisible();
    expect(
      within(row).getByRole("button", { name: "Previous month" }),
    ).toBeVisible();
  });

  it("month mode queries the anchor month's grid range with server-side filters", () => {
    renderScreen({}, { text: "", facets: { kind: ["NOTE"], tag: ["wine"] } });
    expect(mocks.entries).toHaveBeenCalledWith({
      range: monthGridRange(2026, 8),
      kinds: ["NOTE"],
      tag: "wine",
      project: undefined,
    });
  });

  it("queries the month of an explicit anchor date", () => {
    renderScreen(
      { date: "2026-02-10" },
      {
        text: "",
        facets: { project: ["clepsydra"] },
      },
    );
    expect(mocks.entries).toHaveBeenCalledWith(
      expect.objectContaining({
        range: monthGridRange(2026, 1),
        project: "clepsydra",
      }),
    );
  });

  it("shows a count per day", () => {
    const { container } = renderScreen();
    const cell = container.querySelector('[data-date="2026-09-15"]');
    expect(cell?.querySelector("[data-day-count]")).toHaveTextContent("3");
  });

  it("switching mode calls onViewChange with the mode and its default span", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderScreen();
    await user.click(screen.getByRole("radio", { name: "Months" }));
    expect(onViewChange).toHaveBeenCalledWith({ mode: "months", span: 3 });
  });

  it("months mode renders one grid per month and a span control", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderScreen({ mode: "months", span: 3 });
    expect(screen.getAllByRole("grid")).toHaveLength(3);
    await user.click(screen.getByRole("radio", { name: "6 months" }));
    expect(onViewChange).toHaveBeenCalledWith({ span: 6 });
  });

  it("month mode has no span control", () => {
    renderScreen();
    expect(screen.queryByRole("radiogroup", { name: "Span" })).toBeNull();
  });

  it("weeks mode renders week sections with inline titles", () => {
    renderScreen({ mode: "weeks", span: 2 });
    const week = screen.getByRole("region", { name: "Week 40, 2026" });
    expect(
      within(week).getByRole("link", { name: "Tasting Beer" }),
    ).toHaveAttribute("data-path", "notes/beer.md");
    expect(screen.getByRole("region", { name: "Week 41, 2026" })).toBeVisible();
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("weeks mode pages by one week", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderScreen({ mode: "weeks", span: 1 });
    await user.click(screen.getByRole("button", { name: "Next week" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ date: "2026-10-07" });
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ date: "2026-09-23" });
  });

  it("clicking a day calls onViewChange({ day })", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderScreen();
    await user.click(
      screen.getByRole("button", { name: /September 15, 2026/ }),
    );
    expect(onViewChange).toHaveBeenCalledWith({ day: "2026-09-15" });
  });

  it("clicking a day in weeks mode calls onViewChange({ day })", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderScreen({ mode: "weeks", span: 2 });
    await user.click(screen.getByRole("button", { name: /29.*1 page$/ }));
    expect(onViewChange).toHaveBeenCalledWith({ day: "2026-09-29" });
  });

  it("a day in view.day opens the side panel listing that day's notes", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderScreen({ day: "2026-09-15" });
    const panel = screen.getByRole("complementary", { name: "Day" });
    expect(within(panel).getByRole("link", { name: /Alpha/ })).toBeVisible();
    expect(within(panel).getByRole("link", { name: /Bravo/ })).toBeVisible();

    await user.click(
      within(panel).getByRole("button", { name: /Open journal/ }),
    );
    expect(mocks.openJournal).toHaveBeenCalledWith(
      "2026-09-15",
      "journals/2026-09-15.md",
    );

    await user.click(within(panel).getByRole("button", { name: "Close day" }));
    expect(onViewChange).toHaveBeenCalledWith({ day: undefined });
  });

  it("a selected day outside the visible range fetches its own window with the same filters", () => {
    const sep7: CalendarEntry[] = [
      {
        path: "notes/s7a.md",
        title: "Seventh A",
        kind: "NOTE",
        created_at: at("2026-09-07"),
      },
      {
        path: "notes/s7b.md",
        title: "Seventh B",
        kind: "NOTE",
        created_at: at("2026-09-07", 15),
      },
      {
        path: "notes/s7c.md",
        title: "Seventh C",
        kind: "RECIPE",
        created_at: at("2026-09-07", 8),
      },
    ];
    mocks.entries.mockImplementation((opts: { range: { from: Date } }) =>
      opts.range.from.getTime() === new Date(2026, 8, 7).getTime()
        ? queryState({ entries: sep7 })
        : queryState(),
    );
    renderScreen(
      { mode: "weeks", span: 2, date: "2026-09-15", day: "2026-09-07" },
      { text: "", facets: { tag: ["wine"] } },
    );
    expect(mocks.entries).toHaveBeenCalledWith(
      {
        range: { from: new Date(2026, 8, 7), to: new Date(2026, 8, 8) },
        kinds: undefined,
        tag: "wine",
        project: undefined,
      },
      { enabled: true },
    );
    const panel = screen.getByRole("complementary", { name: "Day" });
    expect(
      within(panel).getByRole("link", { name: /Seventh A/ }),
    ).toBeVisible();
    expect(
      within(panel).getByRole("link", { name: /Seventh C/ }),
    ).toBeVisible();
    expect(within(panel).queryByText("Nothing created this day.")).toBeNull();
  });

  it("does not claim an out-of-range day is empty while its window loads", () => {
    mocks.entries.mockImplementation((opts: { range: { from: Date } }) =>
      opts.range.from.getTime() === new Date(2026, 8, 7).getTime()
        ? { data: undefined, isLoading: true, isError: false }
        : queryState(),
    );
    renderScreen({
      mode: "weeks",
      span: 2,
      date: "2026-09-15",
      day: "2026-09-07",
    });
    const panel = screen.getByRole("complementary", { name: "Day" });
    expect(within(panel).queryByText("Nothing created this day.")).toBeNull();
    expect(within(panel).getByRole("status")).toHaveTextContent("Loading…");
  });

  it("an in-range day reads the visible-range query and leaves the day query disabled", () => {
    renderScreen({ day: "2026-09-15" });
    expect(mocks.entries).toHaveBeenCalledWith(expect.anything(), {
      enabled: false,
    });
  });

  it("months mode draws compact cells without count text", () => {
    const { container } = renderScreen({ mode: "months", span: 3 });
    const face = container.querySelector<HTMLElement>(
      '[data-date="2026-09-15"]:not([data-outside])',
    );
    expect(face?.dataset.variant).toBe("compact");
    expect(container.querySelector("[data-day-count]")).toBeNull();
  });

  it("month mode draws page cells", () => {
    const { container } = renderScreen();
    const face = container.querySelector<HTMLElement>(
      '[data-date="2026-09-15"]',
    );
    expect(face?.dataset.variant).toBe("page");
  });

  it("has no side panel without view.day", () => {
    renderScreen();
    expect(screen.queryByRole("complementary", { name: "Day" })).toBeNull();
  });

  it("paging months calls onViewChange with the new anchor date", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderScreen();
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(onViewChange).toHaveBeenLastCalledWith({ date: "2026-10-01" });
  });

  it("shows the truncation notice when truncated", () => {
    mocks.entries.mockReturnValue(queryState({ truncated: true }));
    renderScreen();
    expect(screen.getByText(/Showing the first 5000 pages/)).toBeVisible();
  });

  it("hides the truncation notice otherwise", () => {
    renderScreen();
    expect(screen.queryByText(/Showing the first 5000 pages/)).toBeNull();
  });

  it("renders loading and error states", () => {
    mocks.entries.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    const { unmount } = renderScreen();
    expect(screen.getByRole("status")).toHaveTextContent("Loading Calendar…");
    unmount();

    mocks.entries.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    renderScreen();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t load Calendar.",
    );
  });

  it("filter chips call onFilterChange", async () => {
    const user = userEvent.setup();
    const { onFilterChange } = renderScreen();
    await user.click(screen.getByTestId("filter-bar-chip-kind"));
    await user.click(screen.getByTestId("filter-bar-option-kind-NOTE"));
    expect(onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({
        facets: expect.objectContaining({ kind: ["NOTE"] }),
      }),
    );
  });

  it("offers tag and project values as primary filters", async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByTestId("filter-bar-chip-tag"));
    expect(screen.getByTestId("filter-bar-option-tag-wine")).toBeVisible();
    expect(screen.getByTestId("filter-bar-chip-project")).toBeInTheDocument();
  });

  describe("birthdays", () => {
    const ADA: CalendarBirthday = {
      path: "people/ada.md",
      title: "Ada",
      year: 1983,
      month: 9,
      day: 15,
    };
    const DI: CalendarBirthday = {
      path: "people/di.md",
      title: "Di",
      year: null,
      month: 10,
      day: 2,
    };
    const marker = (container: HTMLElement, key: string) =>
      container.querySelector(`[data-date="${key}"] [data-birthday-marker]`);

    beforeEach(() => {
      mocks.entries.mockReturnValue(queryState({ birthdays: [ADA, DI] }));
    });

    it("marks birthdays across the visible grid, overflow days included", () => {
      const { container } = renderScreen();
      expect(marker(container, "2026-09-15")).not.toBeNull();
      expect(marker(container, "2026-10-02")).not.toBeNull();
      expect(marker(container, "2026-09-16")).toBeNull();
    });

    it("lists the day's birthdays in the side panel", () => {
      renderScreen({ day: "2026-09-15" });
      const panel = screen.getByRole("complementary", { name: "Day" });
      const group = within(panel).getByRole("list", { name: "Birthdays" });
      expect(
        within(group).getByRole("link", { name: "Ada — birthday, turns 43" }),
      ).toHaveAttribute("data-path", "people/ada.md");
    });

    it("weeks mode lists birthdays inline", () => {
      const { container } = renderScreen({
        mode: "weeks",
        span: 1,
        date: "2026-09-15",
      });
      const day = container.querySelector<HTMLElement>(
        '[data-date="2026-09-15"]',
      );
      expect(day).not.toBeNull();
      expect(
        within(day as HTMLElement).getByRole("link", {
          name: "Ada — birthday, turns 43",
        }),
      ).toBeVisible();
    });

    it("hides birthdays when the Kind facet excludes PERSON", () => {
      const { container } = renderScreen(
        {},
        { text: "", facets: { kind: ["NOTE"] } },
      );
      expect(marker(container, "2026-09-15")).toBeNull();
    });

    it("shows birthdays when the Kind facet includes PERSON", () => {
      const { container } = renderScreen(
        {},
        { text: "", facets: { kind: ["NOTE", "PERSON"] } },
      );
      expect(marker(container, "2026-09-15")).not.toBeNull();
    });

    it("an out-of-range day takes its birthdays from its own window", () => {
      const SEP7: CalendarBirthday = {
        path: "people/sev.md",
        title: "Sev",
        year: 2000,
        month: 9,
        day: 7,
      };
      mocks.entries.mockImplementation((opts: { range: { from: Date } }) =>
        opts.range.from.getTime() === new Date(2026, 8, 7).getTime()
          ? queryState({ entries: [], birthdays: [SEP7] })
          : queryState(),
      );
      renderScreen({
        mode: "weeks",
        span: 2,
        date: "2026-09-15",
        day: "2026-09-07",
      });
      const panel = screen.getByRole("complementary", { name: "Day" });
      expect(
        within(panel).getByRole("link", { name: "Sev — birthday, turns 26" }),
      ).toBeVisible();
    });
  });
  describe("todos", () => {
    const todo = (due: string, content: string): CalendarTodoItem => ({
      kind: "todo",
      content,
      status: "todo",
      due,
      page_path: "notes/brew.md",
      span_start: 0,
    });
    const marker = (container: HTMLElement, key: string) =>
      container.querySelector(`[data-date="${key}"] [data-todo-marker]`);

    beforeEach(() => {
      mocks.entries.mockReturnValue(
        queryState({
          todos: [
            todo("2026-09-15", "Buy hops"),
            todo("2026-10-02", "Bottle"),
            todo("2026-12-01", "Far away"),
          ],
        }),
      );
    });

    it("marks todos across the visible grid, overflow days included", () => {
      const { container } = renderScreen();
      expect(marker(container, "2026-09-15")).not.toBeNull();
      expect(marker(container, "2026-10-02")).not.toBeNull();
      expect(marker(container, "2026-09-16")).toBeNull();
    });

    it("lists the day's todos in the side panel", async () => {
      const user = userEvent.setup();
      renderScreen({ day: "2026-09-15" });
      const panel = screen.getByRole("complementary", { name: "Day" });
      const group = within(panel).getByRole("list", { name: "Todos" });
      expect(within(group).getByText("Buy hops")).toBeVisible();
      await user.click(
        within(group).getByRole("button", { name: /Mark Todo done/ }),
      );
      expect(mocks.toggleTodo).toHaveBeenCalledWith({
        pagePath: "notes/brew.md",
        spanStart: 0,
        status: "done",
      });
    });

    it("weeks mode lists todos inline", () => {
      const { container } = renderScreen({
        mode: "weeks",
        span: 1,
        date: "2026-09-15",
      });
      const day = container.querySelector<HTMLElement>(
        '[data-date="2026-09-15"]',
      );
      expect(
        within(day as HTMLElement).getByRole("link", { name: "Buy hops" }),
      ).toBeVisible();
    });

    it("an out-of-range day takes its todos from its own window", () => {
      mocks.entries.mockImplementation((opts: { range: { from: Date } }) =>
        opts.range.from.getTime() === new Date(2026, 8, 7).getTime()
          ? queryState({ entries: [], todos: [todo("2026-09-07", "Seventh")] })
          : queryState(),
      );
      renderScreen({
        mode: "weeks",
        span: 2,
        date: "2026-09-15",
        day: "2026-09-07",
      });
      const panel = screen.getByRole("complementary", { name: "Day" });
      const group = within(panel).getByRole("list", { name: "Todos" });
      expect(within(group).getByText("Seventh")).toBeVisible();
    });

    it("reads a response without todos as none", () => {
      mocks.entries.mockReturnValue({
        data: { entries: ENTRIES, birthdays: [], truncated: false },
        isLoading: false,
        isError: false,
      });
      renderScreen({ day: "2026-09-15" });
      const panel = screen.getByRole("complementary", { name: "Day" });
      expect(within(panel).queryByRole("list", { name: "Todos" })).toBeNull();
    });
  });
});
