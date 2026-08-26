import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgendaResponse,
  AgendaTask,
  AgendaTodo,
} from "#/api/tasks";
import { EMPTY_FILTER_STATE, type FilterState } from "#/lib/filters/model";

const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => router.search,
  }),
  useNavigate: () => router.navigate,
}));

const api = vi.hoisted(() => ({
  agenda: vi.fn(),
  toggleTodo: vi.fn(),
  patchTask: vi.fn(),
  openTab: vi.fn(),
}));

vi.mock("#/api/tasks", () => ({
  useAgenda: api.agenda,
  useToggleTaskStatus: () => ({
    isPending: false,
    mutate: api.toggleTodo,
  }),
}));

vi.mock("#/api/board", () => ({
  usePatchTask: () => ({
    isPending: false,
    mutate: api.patchTask,
  }),
}));

vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => api.openTab }));

import { AGENDA_FILTER_URL, AgendaScreen, Route } from "#/routes/agenda";

function todo(
  content: string,
  index: number,
  overrides: Partial<AgendaTodo> = {},
): AgendaTodo {
  return {
    block_id: `todo-${index}`,
    content,
    kind: "todo",
    page_path: `folios/source-${index}.md`,
    page_title: `Source Folio ${index}`,
    properties: {},
    span_end: index * 10 + 9,
    span_start: index * 10,
    status: "todo",
    ...overrides,
  };
}

function task(
  title: string,
  index: number,
  overrides: Partial<AgendaTask> = {},
): AgendaTask {
  return {
    code: `TSK-${String(index).padStart(4, "0")}`,
    due: "2026-08-26",
    hold: null,
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    kind: "task",
    path: `tasks/project/task-${index}.md`,
    priority: "P2",
    project: "Clepsydra",
    status: "TRIAGE",
    title,
    ...overrides,
  };
}

function response(overrides: Partial<AgendaResponse> = {}): AgendaResponse {
  return {
    overdue: [],
    today: [],
    undated: [],
    upcoming: [],
    ...overrides,
  };
}

function queryState(
  data: AgendaResponse | undefined,
  overrides: Partial<{
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
  }> = {},
) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  };
}

function ControlledAgendaScreen({
  initial = EMPTY_FILTER_STATE,
  data = response(),
}: {
  initial?: FilterState;
  data?: AgendaResponse;
} = {}) {
  const [filterState, setFilterState] = useState<FilterState>(initial);
  return (
    <AgendaScreen
      agenda={queryState(data)}
      filterState={filterState}
      onFilterChange={setFilterState}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  router.search = {};
  api.agenda.mockReturnValue(queryState(response()));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Agenda route filters", () => {
  it("normalizes every persisted status and priority while passing through unknown query keys", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }

    expect(
      validateSearch({
        type: "task",
        todoStatus: "doing",
        todoPriority: "a",
        taskStatus: "field",
        taskPriority: "p1",
        project: "Atlas",
        blocked: true,
        bogus: "keep-me",
      } as never),
    ).toEqual({
      type: "task",
      todoStatus: "doing",
      todoPriority: "A",
      taskStatus: "FIELD",
      taskPriority: "P1",
      project: "Atlas",
      blocked: "1",
      bogus: "keep-me",
      q: undefined,
    });
  });

  it("exposes the exact URL field order", () => {
    expect(AGENDA_FILTER_URL.fields.map((field) => field.id)).toEqual([
      "type",
      "todoStatus",
      "todoPriority",
      "taskStatus",
      "taskPriority",
      "project",
      "blocked",
    ]);
  });
});

describe("AgendaPage", () => {
  it("issues one Agenda query for the browser-local calendar date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 26, 12, 30));
    const Page = Route.options.component;
    if (typeof Page !== "function") {
      throw new Error("Expected a route component");
    }

    render(<Page />);

    expect(api.agenda).toHaveBeenCalledTimes(1);
    expect(api.agenda).toHaveBeenCalledWith("2026-08-26");
  });
});

describe("AgendaScreen", () => {
  it("renders one FilterBar above Today, Upcoming, and Undated tabs", () => {
    render(<ControlledAgendaScreen />);

    const filterBar = screen.getByTestId("filter-bar-add");
    const tabList = screen.getByRole("tablist");
    expect(
      filterBar.compareDocumentPosition(tabList) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByTestId("filter-bar-add")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Upcoming" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Undated" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Inbox" })).toBeNull();
  });

  it("renders separate Overdue and Due Today sections without duplicate rows", () => {
    render(
      <ControlledAgendaScreen
        data={response({
          overdue: [todo("Renew insurance", 1)],
          today: [task("Ship Agenda", 2)],
        })}
      />,
    );

    const overdue = screen.getByRole("heading", { name: "Overdue" });
    const dueToday = screen.getByRole("heading", { name: "Due Today" });
    expect(within(overdue.closest("section")!).getByText("Renew insurance")).toBeVisible();
    expect(within(dueToday.closest("section")!).getByText("Ship Agenda")).toBeVisible();
    expect(screen.getAllByText("Renew insurance")).toHaveLength(1);
    expect(screen.getAllByText("Ship Agenda")).toHaveLength(1);
  });

  it("groups upcoming day items under browser-local date labels", async () => {
    const user = userEvent.setup();
    render(
      <ControlledAgendaScreen
        data={response({
          upcoming: [
            {
              date: "2026-08-27",
              items: [todo("Thursday Todo", 1), task("Thursday Task", 2)],
            },
            {
              date: "2026-08-28",
              items: [task("Friday Task", 3)],
            },
          ],
        })}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Upcoming" }));

    const thursday = screen.getByRole("heading", {
      name: /Thu.*(?:Aug.*27|27.*Aug)/,
    });
    const friday = screen.getByRole("heading", {
      name: /Fri.*(?:Aug.*28|28.*Aug)/,
    });
    expect(within(thursday.closest("section")!).getByText("Thursday Todo")).toBeVisible();
    expect(within(thursday.closest("section")!).getByText("Thursday Task")).toBeVisible();
    expect(within(friday.closest("section")!).getByText("Friday Task")).toBeVisible();
  });

  it("shows only Todos in the Undated tab", async () => {
    const user = userEvent.setup();
    render(
      <ControlledAgendaScreen
        data={response({
          undated: [todo("Unscheduled Todo", 1), task("Unexpected Task", 2)],
        })}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Undated" }));

    expect(screen.getByText("Unscheduled Todo")).toBeVisible();
    expect(screen.queryByText("Unexpected Task")).toBeNull();
  });

  it("renders an explicit loading state", () => {
    render(
      <AgendaScreen
        agenda={queryState(undefined, { isLoading: true })}
        filterState={EMPTY_FILTER_STATE}
        onFilterChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading Agenda…");
  });

  it("renders request errors instead of source-empty copy", () => {
    render(
      <AgendaScreen
        agenda={queryState(undefined, {
          isError: true,
          error: new Error("network down"),
        })}
        filterState={EMPTY_FILTER_STATE}
        onFilterChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t load Agenda.");
    expect(screen.queryByText("Nothing due today.")).toBeNull();
  });

  it("uses distinct copy for filtered-empty and source-empty sections", () => {
    const { rerender } = render(<ControlledAgendaScreen />);
    expect(screen.getByText("Nothing due today.")).toBeVisible();
    expect(screen.queryByText("No items match the filter.")).toBeNull();

    rerender(
      <ControlledAgendaScreen
        key="filtered"
        initial={{ text: "absent", facets: {} }}
        data={response({ today: [todo("Present Todo", 1)] })}
      />,
    );

    expect(screen.getByText("No items match the filter.")).toBeVisible();
    expect(screen.queryByText("Nothing due today.")).toBeNull();
  });

  it("keeps both item kinds eligible when no source-specific facet is active", () => {
    render(
      <ControlledAgendaScreen
        data={response({
          today: [todo("Eligible Todo", 1), task("Eligible Task", 2)],
        })}
      />,
    );

    expect(screen.getByText("Eligible Todo")).toBeVisible();
    expect(screen.getByText("Eligible Task")).toBeVisible();
  });

  it.each([
    ["type", "task", "Matching Task type", "Open Todo"],
    ["todoStatus", "open", "Open Todo", "Doing Todo"],
    ["todoStatus", "doing", "Doing Todo", "Open Todo"],
    ["todoPriority", "A", "High Todo", "Open Todo"],
    ["taskStatus", "FIELD", "Field Task", "P1 Task"],
    ["taskPriority", "P1", "P1 Task", "Field Task"],
    ["project", "Atlas", "Atlas Task", "Field Task"],
    ["blocked", "1", "Blocked Task", "Field Task"],
  ])(
    "applies the %s facet to its documented source domain",
    (field, value, expected, excluded) => {
    const items = [
      todo("Open Todo", 1, { status: "todo" }),
      todo("Doing Todo", 2, { status: "doing" }),
      todo("High Todo", 3, { properties: { priority: "a" } }),
      task("Matching Task type", 4),
      task("Field Task", 5, { status: "FIELD" }),
      task("P1 Task", 6, { priority: "P1" }),
      task("Atlas Task", 7, { project: "Atlas" }),
      task("Blocked Task", 8, { hold: "Waiting" }),
    ];

    render(
      <ControlledAgendaScreen
        initial={{ text: "", facets: { [field]: [value] } }}
        data={response({ today: items })}
      />,
    );

    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.queryByText(excluded)).toBeNull();
    if (field.startsWith("task") || field === "project" || field === "blocked") {
      expect(screen.queryByText("Open Todo")).toBeNull();
    }
    if (field.startsWith("todo")) {
      expect(screen.queryByText("Matching Task type")).toBeNull();
    }
    },
  );

  it("applies text to Todo content and page plus Task title and path", () => {
    render(
      <ControlledAgendaScreen
        initial={{ text: "needle", facets: {} }}
        data={response({
          today: [
            todo("needle content", 1),
            todo("Page title match", 2, { page_title: "Needle Folio" }),
            task("needle title", 3),
            task("Path match", 4, { path: "tasks/needle.md" }),
            todo("Hidden Todo", 5),
            task("Hidden Task", 6),
          ],
        })}
      />,
    );

    expect(screen.getByText("needle content")).toBeVisible();
    expect(screen.getByText("Page title match")).toBeVisible();
    expect(screen.getByText("needle title")).toBeVisible();
    expect(screen.getByText("Path match")).toBeVisible();
    expect(screen.queryByText("Hidden Todo")).toBeNull();
    expect(screen.queryByText("Hidden Task")).toBeNull();
  });

  it("offers the dynamic Project domain and every deterministic facet domain", async () => {
    const user = userEvent.setup();
    render(
      <ControlledAgendaScreen
        data={response({ today: [task("Atlas Task", 1, { project: "Atlas" })] })}
      />,
    );

    const expectedOptions: Record<string, string[]> = {
      type: ["todo", "task"],
      todoStatus: ["open", "doing", "done", "cancelled"],
      todoPriority: ["A", "B", "C"],
      taskStatus: ["INTAKE", "TRIAGE", "FIELD", "REVIEW", "SEALED"],
      taskPriority: ["P0", "P1", "P2", "P3"],
      project: ["Atlas"],
    };

    for (const [field, options] of Object.entries(expectedOptions)) {
      await user.click(screen.getByTestId("filter-bar-add"));
      await user.click(screen.getByTestId(`filter-bar-field-${field}`));
      for (const option of options) {
        expect(screen.getByTestId(`filter-bar-option-${field}-${option}`)).toBeVisible();
      }
      await user.click(
        screen.getByTestId(`filter-bar-option-${field}-${options[0]}`),
      );
      await user.click(screen.getByTestId("filter-bar-clear"));
    }

    await user.click(screen.getByTestId("filter-bar-add"));
    expect(screen.getByTestId("filter-bar-field-blocked")).toBeVisible();
  });
});
