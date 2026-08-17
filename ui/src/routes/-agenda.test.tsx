import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "#/api/tasks";
import { EMPTY_FILTER_STATE, type FilterState } from "#/lib/filters/model";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
}));

const api = vi.hoisted(() => ({
  today: vi.fn(),
  week: vi.fn(),
  overdue: vi.fn(),
  tasks: vi.fn(),
  toggle: vi.fn(),
  openTab: vi.fn(),
}));

vi.mock("#/api/tasks", () => ({
  useAgendaToday: api.today,
  useAgendaWeek: api.week,
  useAgendaOverdue: api.overdue,
  useTasks: api.tasks,
  useToggleTaskStatus: api.toggle,
}));

vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => api.openTab }));

import { AGENDA_FILTER_URL, AgendaScreen, Route } from "#/routes/agenda";

function task(
  content: string,
  index: number,
  overrides: Partial<TaskItem> = {},
): TaskItem {
  return {
    block_id: `task-${index}`,
    content,
    page_path: `folios/source-${index}.md`,
    page_title: `Source Folio ${index}`,
    properties: {},
    span_end: index * 10 + 9,
    span_start: index * 10,
    status: "todo",
    ...overrides,
  };
}

function queryState<T>(data: T | undefined, isLoading = false) {
  return { data, isLoading, isError: false, error: null };
}

/**
 * Local stateful harness standing in for the /agenda route: AgendaScreen is a
 * controlled component (filterState/onFilterChange are route-owned props),
 * so filter-interaction tests need a real state round-trip the same way the
 * route's useMemo/navigate wiring provides it in production.
 */
function ControlledAgendaScreen({
  initial = EMPTY_FILTER_STATE,
}: {
  initial?: FilterState;
} = {}) {
  const [filterState, setFilterState] = useState<FilterState>(initial);
  return (
    <AgendaScreen filterState={filterState} onFilterChange={setFilterState} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.today.mockReturnValue(queryState({ tasks: [] }));
  api.overdue.mockReturnValue(queryState({ tasks: [] }));
  api.week.mockReturnValue(queryState({ days: [] }));
  api.tasks.mockReturnValue(queryState({ tasks: [], total: 0 }));
  api.toggle.mockReturnValue({ isPending: false, mutate: vi.fn() });
});

describe("Agenda route filters", () => {
  it("normalises the shared filter search params, passing through unknown keys", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({
        status: "todo",
        priority: "a",
        bogus: "x",
      } as any),
    ).toEqual({
      status: "todo",
      priority: "A",
      bogus: "x",
      q: undefined,
    });
  });

  it("round-trips an already-normalised facet state and text query through the codec", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({ status: "done", priority: "B", q: "alpha" } as any),
    ).toEqual({
      status: "done",
      priority: "B",
      q: "alpha",
    });
  });

  it("exposes status/priority field ids matching the URL codec", () => {
    expect(AGENDA_FILTER_URL.fields.map((f) => f.id)).toEqual([
      "status",
      "priority",
    ]);
  });
});

describe("AgendaScreen", () => {
  it("renders exactly one FilterBar above the Tabs", () => {
    render(<ControlledAgendaScreen />);

    const filterBars = screen.getAllByTestId("filter-bar-add");
    expect(filterBars).toHaveLength(1);
    const tabList = screen.getByRole("tablist");
    expect(
      filterBars[0].compareDocumentPosition(tabList) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hides non-matching tasks in the Today panel when a priority facet is active", async () => {
    const user = userEvent.setup();
    api.today.mockReturnValue(
      queryState({
        tasks: [
          task("High priority today task", 1, {
            properties: { priority: "A" },
          }),
          task("Low priority today task", 2, {
            properties: { priority: "C" },
          }),
        ],
      }),
    );

    render(<ControlledAgendaScreen />);

    expect(screen.getByText("High priority today task")).toBeInTheDocument();
    expect(screen.getByText("Low priority today task")).toBeInTheDocument();

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-priority"));
    await user.click(screen.getByTestId("filter-bar-option-priority-A"));

    expect(screen.getByText("High priority today task")).toBeInTheDocument();
    expect(
      screen.queryByText("Low priority today task"),
    ).not.toBeInTheDocument();
  });

  it("narrows the Today panel by free text content", async () => {
    const user = userEvent.setup();
    api.today.mockReturnValue(
      queryState({
        tasks: [task("Renew library card", 1), task("Write report", 2)],
      }),
    );

    render(<ControlledAgendaScreen />);

    await user.type(screen.getByTestId("filter-bar-input"), "library");

    expect(screen.getByText("Renew library card")).toBeInTheDocument();
    expect(screen.queryByText("Write report")).not.toBeInTheDocument();
  });

  it("shows a filtered-empty message in the Today panel distinct from the no-data message", async () => {
    const user = userEvent.setup();
    api.today.mockReturnValue(
      queryState({
        tasks: [task("Only task today", 1, { properties: { priority: "C" } })],
      }),
    );

    render(<ControlledAgendaScreen />);

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-priority"));
    await user.click(screen.getByTestId("filter-bar-option-priority-A"));

    expect(screen.getByText(/no tasks match the filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing due today/i)).not.toBeInTheDocument();
  });

  it("composes a status facet on top of the Inbox panel's fixed server params without touching them", async () => {
    const user = userEvent.setup();
    api.tasks.mockReturnValue(
      queryState({
        tasks: [task("Undated inbox task", 1, { status: "todo" })],
        total: 1,
      }),
    );

    render(<ControlledAgendaScreen />);

    // Inbox is not the default tab — react-aria-components only mounts the
    // active TabPanel's children, so useTasks isn't called until selected.
    await user.click(screen.getByRole("tab", { name: "Inbox" }));
    expect(screen.getByText("Undated inbox task")).toBeInTheDocument();
    expect(api.tasks).toHaveBeenCalledWith({
      has_no_date: true,
      status: "todo",
    });

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-status"));
    await user.click(screen.getByTestId("filter-bar-option-status-done"));

    // The Inbox panel's server params are untouched — status:done composes
    // client-side on top of the server's status:todo, legitimately emptying
    // the panel rather than re-querying with a different status.
    expect(api.tasks).toHaveBeenCalledWith({
      has_no_date: true,
      status: "todo",
    });
    expect(api.tasks).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "done" }),
    );
    expect(screen.queryByText("Undated inbox task")).not.toBeInTheDocument();
    expect(screen.getByText(/no tasks match the filter/i)).toBeInTheDocument();
  });

  it("drops a filtered-empty upcoming day from the list but keeps other days visible", async () => {
    const user = userEvent.setup();
    api.week.mockReturnValue(
      queryState({
        days: [
          {
            date: "2026-08-18",
            tasks: [
              task("Tuesday A task", 1, { properties: { priority: "A" } }),
            ],
          },
          {
            date: "2026-08-19",
            tasks: [
              task("Wednesday C task", 2, { properties: { priority: "C" } }),
            ],
          },
        ],
      }),
    );

    render(<ControlledAgendaScreen />);
    await user.click(screen.getByRole("tab", { name: "Upcoming" }));

    expect(screen.getByText("Tuesday A task")).toBeInTheDocument();
    expect(screen.getByText("Wednesday C task")).toBeInTheDocument();

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-priority"));
    await user.click(screen.getByTestId("filter-bar-option-priority-A"));

    expect(screen.getByText("Tuesday A task")).toBeInTheDocument();
    expect(screen.queryByText("Wednesday C task")).not.toBeInTheDocument();
  });
});
