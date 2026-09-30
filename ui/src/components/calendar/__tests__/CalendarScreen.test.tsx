import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEntry } from "#/api/calendar";
import { CalendarScreen } from "#/components/calendar/CalendarScreen";
import { monthGridRange } from "#/lib/calendar/dates";
import type { CalendarViewSearch } from "#/lib/calendar/search";
import { EMPTY_FILTER_STATE, type FilterState } from "#/lib/filters/model";

const mocks = vi.hoisted(() => ({
  entries: vi.fn(),
  openJournal: vi.fn(),
}));

vi.mock("#/api/calendar", () => ({ useCalendarEntries: mocks.entries }));
vi.mock("#/api/index", () => ({
  useTags: () => ({ data: [{ tag: "wine", count: 2, computed_count: 0 }] }),
}));
vi.mock("#/lib/useProjects", () => ({
  useProjectValues: () => ["clepsydra"],
}));
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
    truncated: boolean;
    isLoading: boolean;
    isError: boolean;
  }> = {},
) {
  const { entries = ENTRIES, truncated = false, ...rest } = overrides;
  return {
    data: { entries, truncated },
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
});
