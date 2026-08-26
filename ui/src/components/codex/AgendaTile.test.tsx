import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "#/api/tasks";

const agendaMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  mutate: vi.fn(),
  useTasks: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => agendaMocks.navigate,
}));

vi.mock("#/api/tasks", () => ({
  useTasks: agendaMocks.useTasks,
  useToggleTaskStatus: () => ({
    isPending: false,
    mutate: agendaMocks.mutate,
  }),
}));

import { AgendaTile } from "#/components/codex/AgendaTile";

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

const serverOrderedTasks = [
  task("Later due, low priority", 1, {
    properties: { due: "2026-08-20", priority: "C" },
  }),
  task("Overdue high priority", 2, {
    page_path: "projects/alpha.md",
    page_title: "Alpha Folio",
    properties: { due: "2026-08-13", priority: "A" },
    span_start: 42,
    span_end: 68,
  }),
  task("Undated medium priority", 3, {
    properties: { priority: "B" },
  }),
  task("Fourth server row", 4),
  task("Fifth server row", 5),
  task("Sixth server row", 6),
  task("Seventh server row", 7),
  task("Eighth server row", 8),
  task("Ninth overflow row", 9),
];

function successfulState(tasks = serverOrderedTasks, total = 27) {
  return {
    data: { tasks, total },
    error: null,
    isError: false,
    isLoading: false,
  };
}

function rowFor(content: string): HTMLElement {
  const row = screen.getByText(content).closest("li");
  if (!row) throw new Error(`Expected a task row for ${content}`);
  return row;
}

function agendaTile(): HTMLElement {
  const tile = screen.getByText("Outstanding agenda").closest("section");
  if (!tile) throw new Error("Expected the agenda heading inside a tile");
  return tile;
}

describe("AgendaTile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 7, 14, 12));
    agendaMocks.useTasks.mockReturnValue(successfulState());
  });

  it("requests the authoritative outstanding agenda page", () => {
    render(<AgendaTile />);

    expect(agendaMocks.useTasks).toHaveBeenCalledTimes(1);
    expect(agendaMocks.useTasks).toHaveBeenCalledWith({
      status: "todo",
      sort: "agenda",
      limit: 8,
    });
  });

  it("passes placement classes to the Card-compatible tile root", () => {
    render(<AgendaTile className="agenda-placement" />);

    expect(agendaTile()).toHaveClass("agenda-placement");
  });

  it("preserves server order, renders at most eight rows, and shows the authoritative total", () => {
    render(<AgendaTile />);

    expect(screen.getByText("27 outstanding")).toBeInTheDocument();
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows).toHaveLength(8);
    expect(rows[0]).toHaveTextContent("Later due, low priority");
    expect(rows[1]).toHaveTextContent("Overdue high priority");
    expect(rows[2]).toHaveTextContent("Undated medium priority");
    expect(rows[7]).toHaveTextContent("Eighth server row");
    expect(screen.queryByText("Ninth overflow row")).not.toBeInTheDocument();
  });

  it("presents due dates, overdue state, A/B/C priority labels, and source Folios", () => {
    render(<AgendaTile />);

    const later = rowFor("Later due, low priority");
    expect(within(later).getByText("2026-08-20")).toBeInTheDocument();
    expect(within(later).getByText("LOW")).toBeInTheDocument();
    expect(within(later).getByText("Source Folio 1")).toBeInTheDocument();

    const overdue = rowFor("Overdue high priority");
    expect(within(overdue).getByText("2026-08-13")).toBeInTheDocument();
    expect(within(overdue).getByText("OVERDUE")).toBeInTheDocument();
    expect(within(overdue).getByText("HIGH")).toBeInTheDocument();
    expect(within(overdue).getByText("Alpha Folio")).toBeInTheDocument();

    expect(
      within(rowFor("Undated medium priority")).getByText("MED"),
    ).toBeInTheDocument();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a checked Todo done through the Todo mutation boundary", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<AgendaTile />);

    await user.click(
      within(rowFor("Overdue high priority")).getByRole("button", {
        name: /mark Todo done/i,
      }),
    );

    expect(agendaMocks.mutate).toHaveBeenCalledWith({
      pagePath: "projects/alpha.md",
      spanStart: 42,
      status: "done",
    });
  });

  it("renders an agenda heading action that opens the full agenda", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<AgendaTile />);

    expect(screen.getByText("Outstanding agenda")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /open (the full )?agenda/i }),
    );

    expect(agendaMocks.navigate).toHaveBeenCalledWith({ to: "/agenda" });
  });

  it("renders a loading state inside the tile", () => {
    agendaMocks.useTasks.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isLoading: true,
    });

    render(<AgendaTile />);

    expect(within(agendaTile()).getByRole("status")).toHaveTextContent(
      /loading.*agenda/i,
    );
  });

  it("contains a thrown query failure inside the tile", () => {
    agendaMocks.useTasks.mockImplementation(() => {
      throw new Error("Network unavailable");
    });

    render(<AgendaTile />);

    expect(within(agendaTile()).getByRole("alert")).toHaveTextContent(
      /agenda.*unavailable/i,
    );
  });

  it("renders an empty state when there are no outstanding tasks", () => {
    agendaMocks.useTasks.mockReturnValue(successfulState([], 0));

    render(<AgendaTile />);

    const tile = agendaTile();
    expect(within(tile).getByText(/no outstanding tasks/i)).toBeInTheDocument();
    expect(within(tile).queryByRole("list")).not.toBeInTheDocument();
  });
});
