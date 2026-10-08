/**
 * BacklogView tests: the active-cycle and backlog tables (splitBacklog's
 * own rules are in backlog-tables.test.ts).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCycle, BoardTask } from "#/api/board";
import { useBoardStore } from "#/store/board";
import { BacklogView } from "../BacklogView";
import { BOARD_FIXTURE, FIXTURE_COL_LABEL } from "./fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

/** BacklogView rows nest InlineEditPopover, which needs a QueryClient. */
function wrap(ui: React.ReactElement, fetchStub?: ReturnType<typeof vi.fn>) {
  if (fetchStub) vi.stubGlobal("fetch", fetchStub);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function makePatchStub() {
  return vi.fn((_url: string, opts?: RequestInit) => {
    if (opts?.method === "PATCH") {
      const patch = JSON.parse(opts.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "patched", ...patch }),
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(BOARD_FIXTURE),
    } as Response);
  });
}

/** A matchMedia answering `(min-width: Npx)` for a viewport `width` wide. */
function setViewportWidth(width: number) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      media: query,
      matches: (() => {
        const min = /min-width:\s*(\d+)px/.exec(query);
        return min ? width >= Number(min[1]) : false;
      })(),
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

beforeEach(() => {
  useBoardStore.setState({
    mode: "backlog",
    opFilter: "ALL",
    cycleSel: "",
    railOpen: true,
    showCompleted: false,
    editTaskId: null,
    taskModal: null,
    cycleModal: null,
  });
  setViewportWidth(1440);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function view(
  list: BoardTask[],
  {
    activeCycle = null,
    colLabel = FIXTURE_COL_LABEL,
  }: {
    activeCycle?: BoardCycle | null;
    colLabel?: (id: string) => string;
  } = {},
) {
  return (
    <BacklogView tasks={list} activeCycle={activeCycle} colLabel={colLabel} />
  );
}

const backlogGrid = () => screen.getByRole("grid", { name: "Backlog" });
const cycleGrid = () =>
  screen.getByRole("grid", { name: `Active cycle: ${ACTIVE.label}` });
/** A task's row, by the DataTable's row id. */
const rowOf = (id: string) => {
  const row = document.querySelector<HTMLTableRowElement>(
    `tr[data-row-id="${id}"]`,
  );
  if (!row) throw new Error(`No row for ${id}`);
  return row;
};
const rowIdsIn = (grid: HTMLElement) =>
  Array.from(grid.querySelectorAll<HTMLTableRowElement>("tr[data-row-id]")).map(
    (row) => row.dataset.rowId,
  );
const columnNames = (grid: HTMLElement) =>
  within(grid)
    .getAllByRole("columnheader")
    .map((th) => th.textContent);

// ── shared fixture slices ─────────────────────────────────────────────────────

const ACTIVE: BoardCycle = BOARD_FIXTURE.cycles[0];

// Extra tasks used in BacklogView-specific fixtures

/** P0 task with a due date */
const T_P0_DUE: BoardTask = {
  blocked_by: [],
  blocks: [],
  blocked: false,
  id: "bk-p0-due",
  code: "TSK-1000",
  title: "Critical with due",
  body_excerpt: null,
  status: "FIELD",
  priority: "P0",
  project: "alpha",
  due: "2026-07-01",
  cycle: null,
  tags: [],
  checks: [],
  path: "tasks/bk-p0-due.md",
  updated_at: "2026-06-10T00:00:00Z",
};

/** P0 task without a due date (should sort after T_P0_DUE) */
const T_P0_NODUE: BoardTask = {
  blocked_by: [],
  blocks: [],
  blocked: false,
  id: "bk-p0-nodue",
  code: "TSK-1001",
  title: "Critical no due",
  body_excerpt: null,
  status: "TRIAGE",
  priority: "P0",
  project: "alpha",
  due: null,
  cycle: null,
  tags: [],
  checks: [],
  path: "tasks/bk-p0-nodue.md",
  updated_at: "2026-06-10T00:00:00Z",
};

/** P1 task with a hold */
const T_P1_HOLD: BoardTask = {
  blocked_by: [],
  blocks: [],
  blocked: true,
  id: "bk-p1-hold",
  code: "TSK-1002",
  title: "High priority on hold",
  body_excerpt: null,
  status: "INTAKE",
  priority: "P1",
  project: "alpha",
  hold: "waiting for vendor",
  due: null,
  cycle: null,
  tags: [],
  checks: [],
  path: "tasks/bk-p1-hold.md",
  updated_at: "2026-06-10T00:00:00Z",
};

/** P2 task with checklist checks=[2,5] */
const T_P2_CHECKS: BoardTask = {
  blocked_by: [],
  blocks: [],
  blocked: false,
  id: "bk-p2-checks",
  code: "TSK-1003",
  title: "Normal with checklist",
  body_excerpt: null,
  status: "FIELD",
  priority: "P2",
  project: "alpha",
  due: "2026-08-01",
  cycle: null,
  tags: [],
  checks: [2, 5],
  path: "tasks/bk-p2-checks.md",
  updated_at: "2026-06-10T00:00:00Z",
};

/** P2 task with fully-done checklist checks=[3,3] */
const T_P2_DONE: BoardTask = {
  blocked_by: [],
  blocks: [],
  blocked: false,
  id: "bk-p2-done",
  code: "TSK-1004",
  title: "Normal fully done",
  body_excerpt: null,
  status: "FIELD",
  priority: "P2",
  project: "alpha",
  due: "2026-07-15",
  cycle: null,
  tags: [],
  checks: [3, 3],
  path: "tasks/bk-p2-done.md",
  updated_at: "2026-06-10T00:00:00Z",
};

// P2 task at INTAKE (earlier COL_ORDER index than FIELD) for within-group sort test
const T_P2_INTAKE: BoardTask = {
  blocked_by: [],
  blocks: [],
  blocked: false,
  id: "bk-p2-intake",
  code: "TSK-1005",
  title: "Normal in intake",
  body_excerpt: null,
  status: "INTAKE",
  priority: "P2",
  project: "alpha",
  due: null,
  cycle: null,
  tags: [],
  checks: [],
  path: "tasks/bk-p2-intake.md",
  updated_at: "2026-06-10T00:00:00Z",
};

// ══════════════════════════════════════════════════════════════════════════════
// Tables
// ══════════════════════════════════════════════════════════════════════════════

describe("BacklogView — tables", () => {
  it("shows the active cycle's table above the backlog table", () => {
    const inCycle = { ...T_P1_HOLD, cycle: ACTIVE.code };
    wrap(view([T_P0_DUE, inCycle], { activeCycle: ACTIVE }));
    const grids = screen.getAllByRole("grid");
    expect(grids.map((g) => g.getAttribute("aria-label"))).toEqual([
      `Active cycle: ${ACTIVE.label}`,
      "Backlog",
    ]);
    expect(rowIdsIn(cycleGrid())).toEqual(["bk-p1-hold"]);
    expect(rowIdsIn(backlogGrid())).toEqual(["bk-p0-due"]);
  });

  it("names the cycle, its code, dates and count in the heading", () => {
    const inCycle = { ...T_P1_HOLD, cycle: ACTIVE.code };
    wrap(view([inCycle], { activeCycle: ACTIVE }));
    const heading = screen.getByRole("heading", { name: /Cycle 01/ });
    expect(heading).toHaveTextContent("Cycle 01");
    expect(heading).toHaveTextContent("C-01 · 26 May – 8 Jun · 1 task");
    expect(heading.querySelector("[data-tick]")).not.toBeNull();
    expect(screen.getByText("Cycle 01")).toHaveClass("font-serif", "italic");
  });

  it("captions the backlog with its count", () => {
    wrap(view([T_P0_DUE, T_P1_HOLD]));
    expect(screen.getByRole("heading", { name: /Backlog/ })).toHaveTextContent(
      "2 tasks",
    );
  });

  it("has only the backlog table without an active cycle", () => {
    wrap(view([{ ...T_P0_DUE, cycle: "C-01" }]));
    expect(screen.getAllByRole("grid")).toHaveLength(1);
    expect(rowIdsIn(backlogGrid())).toEqual(["bk-p0-due"]);
  });

  it("gives each table its own header row", () => {
    wrap(view([T_P0_DUE], { activeCycle: ACTIVE }));
    const names = [
      "Code",
      "Task",
      "Project",
      "Status",
      "Assignee",
      "Estimate",
      "Due",
      "Checklist",
    ];
    expect(columnNames(cycleGrid())).toEqual(names);
    expect(columnNames(backlogGrid())).toEqual(names);
  });

  it("caps each table at ten rows and virtualises the rest", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...T_P2_INTAKE,
      id: `many-${i}`,
      code: `TSK-${3000 + i}`,
    }));
    wrap(view(many));
    const grid = backlogGrid();
    expect(grid).toHaveAttribute("aria-rowcount", "41");
    expect(grid.parentElement?.style.maxHeight).toBe("440px");
    expect(rowIdsIn(grid).length).toBeLessThan(40);
  });

  it("sorts by priority, then status, then due date", () => {
    const noDue = { ...T_P2_CHECKS, id: "p2-field-nodue", due: null };
    wrap(view([T_P2_CHECKS, noDue, T_P2_INTAKE, T_P1_HOLD, T_P0_NODUE]));
    expect(rowIdsIn(backlogGrid())).toEqual([
      "bk-p0-nodue",
      "bk-p1-hold",
      "bk-p2-intake",
      "bk-p2-checks",
      "p2-field-nodue",
    ]);
  });

  it("hides SEALED tasks unless the board shows completed ones", () => {
    const sealed = { ...T_P0_DUE, id: "bk-sealed", status: "SEALED" };
    const { unmount } = wrap(view([sealed, T_P1_HOLD]));
    expect(rowIdsIn(backlogGrid())).toEqual(["bk-p1-hold"]);
    unmount();
    useBoardStore.setState({ showCompleted: true });
    wrap(view([sealed, T_P1_HOLD]));
    expect(rowIdsIn(backlogGrid())).toEqual(["bk-sealed", "bk-p1-hold"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Rows
// ══════════════════════════════════════════════════════════════════════════════

describe("BacklogView — row rendering", () => {
  it("renders the code, title and project", () => {
    wrap(view([T_P0_DUE]));
    const row = rowOf("bk-p0-due");
    expect(within(row).getByText("TSK-1000")).toBeInTheDocument();
    expect(within(row).getByText("Critical with due")).toBeInTheDocument();
    expect(within(row).getByText("alpha")).toBeInTheDocument();
  });

  it("names each row by its code", () => {
    wrap(view([T_P0_DUE]));
    expect(screen.getByRole("row", { name: "TSK-1000" })).toBe(
      rowOf("bk-p0-due"),
    );
  });

  it("renders the Blocked pill in the task cell only when blocked", () => {
    wrap(view([T_P1_HOLD, T_P0_DUE]));
    expect(screen.getByTestId("bk-hold-tag-bk-p1-hold")).toHaveTextContent(
      "Blocked",
    );
    expect(
      screen.queryByTestId("bk-hold-tag-bk-p0-due"),
    ).not.toBeInTheDocument();
  });

  it("renders the task type chip, none for untyped", () => {
    wrap(view([{ ...T_P0_DUE, task_type: "STORY" }, T_P1_HOLD]));
    expect(within(rowOf("bk-p0-due")).getByText("STORY")).toBeInTheDocument();
    expect(
      within(rowOf("bk-p1-hold")).queryByText("STORY"),
    ).not.toBeInTheDocument();
  });

  it("renders the due date as day and short month, ISO in its title", () => {
    wrap(view([T_P0_DUE]));
    expect(screen.getByText("1 Jul")).toHaveAttribute("title", "2026-07-01");
  });

  it("renders em-dashes for missing values", () => {
    wrap(view([T_P0_NODUE]));
    expect(within(rowOf("bk-p0-nodue")).getAllByText("—").length).toBe(3);
  });

  it("renders state pip + canonical status label in the Status cell", () => {
    wrap(
      view([T_P0_DUE], {
        colLabel: (id) => (id === "FIELD" ? "In Progress" : id),
      }),
    );
    expect(within(rowOf("bk-p0-due")).getByText("In Progress")).toBeVisible();
  });

  // At 1024px the full column set left the title 0px (review I1): narrower
  // widths drop Assignee/Estimate, then Project/Checklist.
  it("drops secondary columns on narrower screens", () => {
    setViewportWidth(1300);
    const { unmount } = wrap(view([T_P0_DUE]));
    expect(columnNames(backlogGrid())).toEqual([
      "Code",
      "Task",
      "Project",
      "Status",
      "Due",
      "Checklist",
    ]);
    unmount();
    setViewportWidth(1024);
    wrap(view([T_P0_DUE]));
    expect(columnNames(backlogGrid())).toEqual([
      "Code",
      "Task",
      "Status",
      "Due",
    ]);
  });
});

describe("BacklogView — checklist dots", () => {
  const dots = (id: string) =>
    rowOf(id).querySelectorAll("[data-testid^='bk-dot-']");
  const doneDots = (id: string) =>
    rowOf(id).querySelectorAll("[data-testid^='bk-dot-'][data-done='true']");

  it("renders one dot per item, done ones marked", () => {
    wrap(view([T_P2_CHECKS, T_P2_DONE, T_P0_DUE]));
    expect(dots("bk-p2-checks")).toHaveLength(5);
    expect(doneDots("bk-p2-checks")).toHaveLength(2);
    expect(dots("bk-p2-done")).toHaveLength(3);
    expect(doneDots("bk-p2-done")).toHaveLength(3);
    expect(dots("bk-p0-due")).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Interaction
// ══════════════════════════════════════════════════════════════════════════════

describe("BacklogView — opening a task", () => {
  it("clicking a row opens its task", async () => {
    wrap(view([T_P0_DUE, T_P1_HOLD]));
    await userEvent.click(within(rowOf("bk-p1-hold")).getByText("alpha"));
    expect(useBoardStore.getState().editTaskId).toBe("bk-p1-hold");
  });

  it("pressing Enter on a focused row opens its task", async () => {
    const user = userEvent.setup();
    wrap(view([T_P0_DUE]));
    rowOf("bk-p0-due").focus();
    await user.keyboard("{Enter}");
    expect(useBoardStore.getState().editTaskId).toBe("bk-p0-due");
  });

  it("tints the row being edited", () => {
    useBoardStore.setState({ editTaskId: "bk-p1-hold" });
    wrap(view([T_P0_DUE, T_P1_HOLD]));
    expect(rowOf("bk-p1-hold").className).toContain("[&>td]:bg-accent-tint");
    expect(rowOf("bk-p0-due").className).not.toContain("bg-accent-tint");
  });

  it("marks the row being edited as current", () => {
    useBoardStore.setState({ editTaskId: "bk-p1-hold" });
    wrap(view([T_P0_DUE, T_P1_HOLD]));
    expect(rowOf("bk-p1-hold")).toHaveAttribute("aria-current", "true");
    expect(rowOf("bk-p0-due")).not.toHaveAttribute("aria-current");
  });
});

describe("BacklogView — inline editing", () => {
  it("status trigger patches status without opening the edit panel", async () => {
    const stub = makePatchStub();
    wrap(view([T_P0_DUE]), stub);

    const user = userEvent.setup();
    // T_P0_DUE is FIELD — pick REVIEW in the popover
    await user.click(screen.getByTestId(`bk-inline-status-${T_P0_DUE.id}`));
    await user.click(screen.getByTestId("inline-status-REVIEW"));

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter((args) => {
        const opts = args[1] as RequestInit | undefined;
        return opts?.method === "PATCH";
      });
      expect(patchCalls.length).toBeGreaterThan(0);
      const opts = patchCalls[0][1] as RequestInit;
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body).toEqual({ status: "REVIEW" });
    });

    // The edit panel must NOT have opened for this click sequence.
    expect(useBoardStore.getState().editTaskId).toBeNull();
  });

  it("priority trigger opens its popover without opening the edit panel", async () => {
    const user = userEvent.setup();
    wrap(view([T_P0_DUE]));
    await user.click(screen.getByTestId(`bk-inline-priority-${T_P0_DUE.id}`));
    expect(
      screen.getByRole("dialog", { name: "Set priority" }),
    ).toBeInTheDocument();
    expect(useBoardStore.getState().editTaskId).toBeNull();
  });
});

describe("BacklogView — empty states", () => {
  it("says so in each empty table, under its header", () => {
    wrap(view([], { activeCycle: ACTIVE }));
    expect(
      within(cycleGrid()).getByText("No tasks in this cycle"),
    ).toBeInTheDocument();
    expect(
      within(backlogGrid()).getByText("No tasks in the backlog"),
    ).toBeInTheDocument();
    expect(columnNames(backlogGrid())).toContain("Code");
  });

  it("shows no empty state in a table with tasks", () => {
    wrap(view([T_P0_DUE]));
    expect(
      screen.queryByText("No tasks in the backlog"),
    ).not.toBeInTheDocument();
  });
});

describe("BacklogView — QuickAddRow wiring", () => {
  it("renders a QuickAddRow with an empty preset above the tables", () => {
    wrap(view([T_P0_DUE]));
    const row = screen.getByTestId("qa-backlog");
    expect(row).toHaveAttribute("placeholder", "+ New task");
    expect(
      row.compareDocumentPosition(backlogGrid()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
