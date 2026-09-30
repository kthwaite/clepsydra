import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCalendarEntries } from "#/api/calendar";
import { FolioCalendarSection } from "#/components/calendar/FolioCalendarSection";
import { useOpenJournalForDate } from "#/hooks/useOpenJournalForDate";
import type { CalendarEntryLike } from "#/lib/calendar/bucket";
import { monthGridRange } from "#/lib/calendar/dates";
import { COLLAPSED_KEY, HIDDEN_KINDS_KEY } from "#/lib/calendar/railPrefs";

vi.mock("#/api/calendar", () => ({ useCalendarEntries: vi.fn() }));
vi.mock("#/hooks/useOpenJournalForDate", () => ({
  useOpenJournalForDate: vi.fn(),
}));
vi.mock("#/components/codex/CLink", () => ({
  CLink: ({ path, children }: { path?: string; children: React.ReactNode }) => (
    <a
      href={`/pages/${path}`}
      data-path={path}
      onClick={(e) => e.preventDefault()}
    >
      {children}
    </a>
  ),
}));

const mockEntries = vi.mocked(useCalendarEntries);
const openJournal = vi.fn(async () => {});

const sept: CalendarEntryLike[] = [
  {
    path: "journals/2026-09-15.md",
    title: "15 Sep",
    kind: "JOURNAL",
    journal_date: "2026-09-15",
  },
  {
    path: "notes/alpha.md",
    title: "Alpha",
    kind: "NOTE",
    created_at: "2026-09-15T10:00:00Z",
  },
  {
    path: "recipes/soup.md",
    title: "Soup",
    kind: "RECIPE",
    created_at: "2026-09-15T12:00:00Z",
  },
  {
    path: "notes/beta.md",
    title: "Beta",
    kind: "NOTE",
    created_at: "2026-09-16T12:00:00Z",
  },
];

function respond(entries: CalendarEntryLike[] = sept, truncated = false) {
  mockEntries.mockReturnValue({
    data: { entries, truncated },
  } as unknown as ReturnType<typeof useCalendarEntries>);
}

const monthHeading = () => screen.getByRole("heading", { level: 3 });

const cell = (container: HTMLElement, key: string) => {
  const el = container.querySelector<HTMLElement>(`[data-date="${key}"]`);
  if (!el) throw new Error(`no cell for ${key}`);
  return el;
};

const dayButton = (n: number) =>
  screen.getByRole("button", { name: new RegExp(`September ${n}, 2026`) });

const longDate = (y: number, m0: number, d: number) =>
  new Date(y, m0, d).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

const NOTE_PAGE = {
  path: "notes/current.md",
  kind: "NOTE",
  createdAt: "2026-09-10T09:00:00Z",
};

describe("FolioCalendarSection", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockEntries.mockReset();
    openJournal.mockClear();
    vi.mocked(useOpenJournalForDate).mockReturnValue(openJournal);
    respond();
  });
  afterEach(() => vi.useRealTimers());

  it("starts on the journal page's month", () => {
    respond([]);
    render(
      <FolioCalendarSection
        path="journals/2026-03-10.md"
        kind="JOURNAL"
        createdAt="2026-09-01T09:00:00Z"
      />,
    );
    expect(monthHeading()).toHaveTextContent("March 2026");
    const [opts] = mockEntries.mock.calls[0];
    expect(opts.range).toEqual(monthGridRange(2026, 2));
    expect(opts.kinds).toBeUndefined();
  });

  it("starts on created_at's local month for other kinds", () => {
    render(<FolioCalendarSection {...NOTE_PAGE} />);
    expect(monthHeading()).toHaveTextContent("September 2026");
  });

  it("falls back to today when the page has neither", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 12, 10));
    render(
      <FolioCalendarSection path="notes/x.md" kind="NOTE" createdAt={null} />,
    );
    expect(monthHeading()).toHaveTextContent("June 2026");
  });

  it("re-anchors when the open page changes", () => {
    const { rerender } = render(<FolioCalendarSection {...NOTE_PAGE} />);
    expect(monthHeading()).toHaveTextContent("September 2026");
    rerender(
      <FolioCalendarSection
        path="notes/older.md"
        kind="NOTE"
        createdAt="2025-12-24T09:00:00Z"
      />,
    );
    expect(monthHeading()).toHaveTextContent("December 2025");
  });

  it("highlights the open page's date", () => {
    const { container } = render(<FolioCalendarSection {...NOTE_PAGE} />);
    const selected = container.querySelectorAll("[data-selected]");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAttribute("data-date", "2026-09-10");
  });

  it("kind toggle hides dots and persists hidden kinds", async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(
      <FolioCalendarSection {...NOTE_PAGE} />,
    );
    const dots = () =>
      cell(container, "2026-09-15").querySelectorAll("[data-kind-dot]");
    expect(dots()).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Calendar kinds" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Recipe/ }));

    expect(dots()).toHaveLength(2);
    expect(window.localStorage.getItem(HIDDEN_KINDS_KEY)).toBe('["RECIPE"]');
    // Toggling filters on the client: the query options never carry kinds.
    for (const [opts] of mockEntries.mock.calls) {
      expect(opts.kinds).toBeUndefined();
    }

    unmount();
    const again = render(<FolioCalendarSection {...NOTE_PAGE} />);
    expect(
      cell(again.container, "2026-09-15").querySelectorAll("[data-kind-dot]"),
    ).toHaveLength(2);
  });

  it("clicking a day opens a popover listing that day's notes grouped by kind", async () => {
    const user = userEvent.setup();
    render(<FolioCalendarSection {...NOTE_PAGE} />);
    await user.click(dayButton(15));
    const dialog = screen.getByRole("dialog", { name: longDate(2026, 8, 15) });
    expect(within(dialog).getByRole("list", { name: "Journal" })).toBeTruthy();
    expect(within(dialog).getByRole("list", { name: "Note" })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /Alpha/ })).toBeTruthy();
  });

  it("opening a note closes the popover", async () => {
    const user = userEvent.setup();
    render(<FolioCalendarSection {...NOTE_PAGE} />);
    await user.click(dayButton(15));
    const dialog = screen.getByRole("dialog", { name: longDate(2026, 8, 15) });
    await user.click(within(dialog).getByRole("link", { name: /Alpha/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Open journal passes the existing journal path when one is written", async () => {
    const user = userEvent.setup();
    render(<FolioCalendarSection {...NOTE_PAGE} />);
    await user.click(dayButton(15));
    await user.click(
      screen.getByRole("button", { name: /Open journal · written/ }),
    );
    expect(openJournal).toHaveBeenCalledWith(
      "2026-09-15",
      "journals/2026-09-15.md",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Open journal passes undefined when the day has no journal", async () => {
    const user = userEvent.setup();
    render(<FolioCalendarSection {...NOTE_PAGE} />);
    await user.click(dayButton(16));
    await user.click(screen.getByRole("button", { name: "Open journal" }));
    expect(openJournal).toHaveBeenCalledWith("2026-09-16", undefined);
  });

  it("collapse hides the calendar and persists", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<FolioCalendarSection {...NOTE_PAGE} />);
    const toggle = screen.getByRole("button", { name: "Collapse calendar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);

    const expand = screen.getByRole("button", { name: "Expand calendar" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("grid")).toBeNull();
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe("1");

    unmount();
    render(<FolioCalendarSection {...NOTE_PAGE} />);
    expect(screen.queryByRole("grid")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand calendar" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("does not fetch while collapsed, and fetches once expanded", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(COLLAPSED_KEY, "1");
    render(<FolioCalendarSection {...NOTE_PAGE} />);
    expect(mockEntries.mock.calls.length).toBeGreaterThan(0);
    for (const [, flags] of mockEntries.mock.calls) {
      expect(flags).toEqual({ enabled: false });
    }
    await user.click(screen.getByRole("button", { name: "Expand calendar" }));
    expect(mockEntries.mock.lastCall?.[1]).toEqual({ enabled: true });
  });

  it("keeps manual paging and the open day across same-page rerenders", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FolioCalendarSection {...NOTE_PAGE} />);
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(monthHeading()).toHaveTextContent("August 2026");
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await user.click(dayButton(15));
    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(<FolioCalendarSection {...NOTE_PAGE} />);
    expect(screen.getByRole("dialog")).toBeTruthy();

    // A refetch that moves created_at to another day is not a new page.
    rerender(
      <FolioCalendarSection {...NOTE_PAGE} createdAt="2026-07-02T09:00:00Z" />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    // The open popover hides the rail from the accessibility tree.
    expect(
      screen.getByRole("heading", { level: 3, hidden: true }),
    ).toHaveTextContent("September 2026");
  });

  it("keeps a paged month when created_at changes on the same page", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FolioCalendarSection {...NOTE_PAGE} />);
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(monthHeading()).toHaveTextContent("October 2026");
    rerender(
      <FolioCalendarSection {...NOTE_PAGE} createdAt="2026-07-02T09:00:00Z" />,
    );
    expect(monthHeading()).toHaveTextContent("October 2026");
  });

  it("anchors to created_at when it arrives late for the same page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 12, 10));
    const { rerender } = render(
      <FolioCalendarSection {...NOTE_PAGE} createdAt={null} />,
    );
    expect(monthHeading()).toHaveTextContent("June 2026");
    rerender(<FolioCalendarSection {...NOTE_PAGE} />);
    expect(monthHeading()).toHaveTextContent("September 2026");
    // Once anchored, later created_at changes leave the month alone.
    rerender(
      <FolioCalendarSection {...NOTE_PAGE} createdAt="2026-03-02T09:00:00Z" />,
    );
    expect(monthHeading()).toHaveTextContent("September 2026");
  });

  it("shows 5000+ when the response is truncated", () => {
    respond(sept, true);
    render(<FolioCalendarSection {...NOTE_PAGE} />);
    expect(screen.getByText("5000+")).toBeTruthy();
  });

  it("renders an empty grid while loading", () => {
    mockEntries.mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useCalendarEntries>);
    render(<FolioCalendarSection {...NOTE_PAGE} />);
    expect(screen.getByRole("grid")).toBeTruthy();
    expect(screen.queryByText("5000+")).toBeNull();
  });
});
