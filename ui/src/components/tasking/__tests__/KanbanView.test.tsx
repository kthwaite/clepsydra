/**
 * KanbanView + TaskCard tests.
 *
 * DnD assertions use fireEvent (not userEvent) because HTML5 drag events
 * are synthetic and do not rely on pointer simulation.
 *
 * Fetch stub pattern: vi.fn() returning a Response-shaped object — same
 * approach used across the tasking test suite.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardTask } from "#/api/board";
import { useBoardStore } from "#/store/board";
import { KanbanView, visibleInKanban } from "../KanbanView";
import {
  BOARD_FIXTURE,
  BOARD_FIXTURE_WITH_CLOSED_CYCLE,
  CLOSED_CYCLE,
  SEALED_IN_CLOSED_CYCLE_TASK,
} from "./fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement, fetchStub?: ReturnType<typeof vi.fn>) {
  if (fetchStub) vi.stubGlobal("fetch", fetchStub);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function makeStub(board = BOARD_FIXTURE) {
  return vi.fn((_url: string, opts?: RequestInit) => {
    // PATCH requests return the patched task (minimal)
    if (opts?.method === "PATCH") {
      const patch = JSON.parse(opts.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "patched", ...patch }),
      } as Response);
    }
    // GET requests return the board
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(board),
    } as Response);
  });
}

const { columns, tasks, cycles } = BOARD_FIXTURE;

beforeEach(() => {
  useBoardStore.setState({
    mode: "card",
    opFilter: "ALL",
    cycleSel: "",
    railOpen: true,
    editTaskId: null,
    taskModal: null,
    cycleModal: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ══════════════════════════════════════════════════════════════════════════════
// visibleInKanban — pure unit tests
// ══════════════════════════════════════════════════════════════════════════════

describe("visibleInKanban", () => {
  it("returns all tasks when no cycles are CLOSED", () => {
    const result = visibleInKanban(tasks, cycles);
    expect(result).toHaveLength(tasks.length);
  });

  it("excludes SEALED tasks whose cycle is CLOSED", () => {
    const { tasks: augTasks, cycles: augCycles } =
      BOARD_FIXTURE_WITH_CLOSED_CYCLE;
    const result = visibleInKanban(augTasks, augCycles);
    expect(result.some((t) => t.id === SEALED_IN_CLOSED_CYCLE_TASK.id)).toBe(
      false,
    );
  });

  it("keeps SEALED tasks whose cycle is ACTIVE or PLANNED", () => {
    // t5 is SEALED with cycle C-01 which is ACTIVE
    const result = visibleInKanban(tasks, cycles);
    expect(result.some((t) => t.id === "t5")).toBe(true);
  });

  it("keeps SEALED tasks with no cycle", () => {
    const sealedNoCycle: BoardTask = {
      ...tasks[4],
      id: "t-sealed-nocycle",
      code: "TSK-9999",
      cycle: null,
      status: "SEALED",
    };
    const result = visibleInKanban([sealedNoCycle], [CLOSED_CYCLE]);
    expect(result).toHaveLength(1);
  });

  it("does NOT filter non-SEALED tasks even when their cycle is CLOSED", () => {
    const fieldInClosed: BoardTask = {
      ...tasks[0],
      id: "t-field-closed",
      code: "TSK-8888",
      status: "FIELD",
      cycle: "C-00", // CLOSED cycle
    };
    const result = visibleInKanban([fieldInClosed], [CLOSED_CYCLE]);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when all tasks are SEALED in a CLOSED cycle", () => {
    const result = visibleInKanban(
      [SEALED_IN_CLOSED_CYCLE_TASK],
      BOARD_FIXTURE_WITH_CLOSED_CYCLE.cycles,
    );
    expect(result).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// KanbanView render
// ══════════════════════════════════════════════════════════════════════════════

describe("KanbanView — column rendering", () => {
  it("renders one column per board.columns entry", () => {
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    for (const col of columns) {
      expect(screen.getByTestId(`kb-col-${col.id}`)).toBeInTheDocument();
    }
  });

  it("renders — NONE — in columns with no tasks", () => {
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    // TRIAGE has only t3, REVIEW has no tasks at all
    expect(screen.getByTestId("kb-empty-REVIEW")).toBeInTheDocument();
    expect(screen.getByTestId("kb-empty-REVIEW").textContent).toContain("NONE");
  });

  it("buckets tasks into the correct columns by status", () => {
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    // t1 is FIELD
    const fieldCol = screen.getByTestId("kb-col-FIELD");
    expect(fieldCol).toHaveTextContent("Task Alpha 1");

    // t2, t4 are INTAKE
    const intakeCol = screen.getByTestId("kb-col-INTAKE");
    expect(intakeCol).toHaveTextContent("Task Alpha 2");
    expect(intakeCol).toHaveTextContent("Task Unfiled");
  });

  it("sorts cards by PRI_ORDER within each column (P1 before P2)", () => {
    // Both t2 (P2) and t4 (P3) are in INTAKE; they should appear P2 then P3
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    const intakeCol = screen.getByTestId("kb-col-INTAKE");
    const cards = intakeCol.querySelectorAll("[data-testid^='task-card-']");
    // t2 is P2, t4 is P3 → t2 first
    expect(cards[0]).toHaveAttribute("data-testid", "task-card-t2");
    expect(cards[1]).toHaveAttribute("data-testid", "task-card-t4");
  });
});

// ── sealed-in-closed-cycle exclusion (render-level) ──────────────────────────

describe("KanbanView — sealed-in-closed-cycle exclusion", () => {
  it("excludes a SEALED task in a CLOSED cycle from the SEALED column", () => {
    const { tasks: augTasks, cycles: augCycles } =
      BOARD_FIXTURE_WITH_CLOSED_CYCLE;
    wrap(
      <KanbanView
        columns={columns}
        tasks={augTasks}
        cycles={augCycles}
        showOp={false}
      />,
    );
    const sealedCol = screen.getByTestId("kb-col-SEALED");
    expect(sealedCol).not.toHaveTextContent("Historical Sealed Task");
  });

  it("still shows — NONE — in SEALED when all sealed are in closed cycles", () => {
    const closedCycleOnlyTasks = [SEALED_IN_CLOSED_CYCLE_TASK];
    wrap(
      <KanbanView
        columns={columns}
        tasks={closedCycleOnlyTasks}
        cycles={BOARD_FIXTURE_WITH_CLOSED_CYCLE.cycles}
        showOp={false}
      />,
    );
    expect(screen.getByTestId("kb-empty-SEALED")).toBeInTheDocument();
  });
});

// ── WIP count and over-capacity styling ──────────────────────────────────────

describe("KanbanView — WIP count and over-capacity", () => {
  it("shows zero-padded count e.g. 02/wip", () => {
    const wipColumns = columns.map((c) =>
      c.id === "INTAKE" ? { ...c, wip: 3 } : c,
    );
    wrap(
      <KanbanView
        columns={wipColumns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    // INTAKE has 2 tasks (t2, t4), wip=3
    expect(screen.getByTestId("kb-cnt-INTAKE").textContent).toBe("02/3");
  });

  it("shows over flag when count exceeds wip", () => {
    const wipColumns = columns.map((c) =>
      c.id === "INTAKE" ? { ...c, wip: 1 } : c,
    );
    wrap(
      <KanbanView
        columns={wipColumns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    // INTAKE has 2 tasks (t2, t4), wip=1 → over
    const cnt = screen.getByTestId("kb-cnt-INTAKE");
    expect(cnt.textContent).toBe("02/1");
    // The over state uses var(--hot) colour
    expect(cnt).toHaveStyle({ color: "var(--hot)" });
  });

  it("shows count without /wip when wip=0", () => {
    // BOARD_FIXTURE has wip=0 on all columns
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    // INTAKE: 2 tasks, no wip suffix
    expect(screen.getByTestId("kb-cnt-INTAKE").textContent).toBe("02");
  });
});

// ── TaskCard anatomy ──────────────────────────────────────────────────────────

describe("TaskCard — card anatomy", () => {
  function renderWithHold() {
    // t2 has hold="blocker"
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
  }

  it("renders HOLD stamp when task.hold is set", () => {
    renderWithHold();
    expect(screen.getByTestId("hold-stamp-t2")).toBeInTheDocument();
    expect(screen.getByTestId("hold-stamp-t2").textContent).toBe("HOLD");
  });

  it("renders hold reason line when task.hold is set", () => {
    renderWithHold();
    expect(screen.getByTestId("hold-line-t2")).toBeInTheDocument();
    expect(screen.getByTestId("hold-line-t2")).toHaveTextContent("blocker");
  });

  it("does not render HOLD stamp for tasks without hold", () => {
    renderWithHold();
    expect(screen.queryByTestId("hold-stamp-t1")).not.toBeInTheDocument();
  });

  it("shows checklist progress bar with d/total", () => {
    const taskWithChecks: BoardTask = {
      ...tasks[0],
      id: "t-chk",
      code: "TSK-0010",
      status: "INTAKE",
      checks: [3, 5],
    };
    wrap(
      <KanbanView
        columns={columns}
        tasks={[taskWithChecks]}
        cycles={cycles}
        showOp={false}
      />,
    );
    expect(screen.getByText("3/5")).toBeInTheDocument();
  });

  it("checklist bar turns done colour when all checks complete", () => {
    const taskDone: BoardTask = {
      ...tasks[0],
      id: "t-done",
      code: "TSK-0011",
      status: "INTAKE",
      checks: [4, 4],
    };
    wrap(
      <KanbanView
        columns={columns}
        tasks={[taskDone]}
        cycles={cycles}
        showOp={false}
      />,
    );
    expect(screen.getByText("4/4")).toBeInTheDocument();
    // The progress bar fill should have cool color (done state)
    // Check via the parent test id structure
    const card = screen.getByTestId("task-card-t-done");
    // The fill element has style background: var(--cool) when done
    const fill = card.querySelector("i");
    expect(fill).toHaveStyle({ background: "var(--cool)" });
  });

  it("does not render checklist section when checks array is empty", () => {
    // t1 has checks=[] — no d/total text
    wrap(
      <KanbanView
        columns={columns}
        tasks={[tasks[0]]}
        cycles={cycles}
        showOp={false}
      />,
    );
    // No progress fraction text
    expect(screen.queryByText(/\d\/\d/)).not.toBeInTheDocument();
  });
});

// ── card click sets editTaskId ────────────────────────────────────────────────

describe("KanbanView — card interactions", () => {
  it("clicking a card calls setEditTaskId with the task id", async () => {
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    const card = screen.getByTestId("task-card-t1");
    await userEvent.click(card);
    expect(useBoardStore.getState().editTaskId).toBe("t1");
  });

  it("dossier link click does not propagate to card click", async () => {
    const onOpenDossier = vi.fn();
    const taskWithLink: BoardTask = {
      ...tasks[0],
      id: "t-link",
      code: "TSK-0020",
      status: "INTAKE",
      link: "tasks/alpha",
    };
    wrap(
      <KanbanView
        columns={columns}
        tasks={[taskWithLink]}
        cycles={cycles}
        showOp={false}
        onOpenDossier={onOpenDossier}
      />,
    );
    const link = screen.getByText("tasks/alpha");
    await userEvent.click(link);
    // Dossier handler called
    expect(onOpenDossier).toHaveBeenCalledWith("tasks/alpha");
    // editTaskId was NOT set (stopPropagation worked)
    expect(useBoardStore.getState().editTaskId).toBeNull();
  });
});

// ── + button opens taskModal with status preset ───────────────────────────────

describe("KanbanView — column + button", () => {
  it("clicking + in a column opens taskModal with that column's status", async () => {
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    const addBtn = screen.getByTestId("kb-add-FIELD");
    await userEvent.click(addBtn);
    expect(useBoardStore.getState().taskModal).toEqual({ status: "FIELD" });
  });

  it("clicking + in INTAKE opens taskModal with status INTAKE", async () => {
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    await userEvent.click(screen.getByTestId("kb-add-INTAKE"));
    expect(useBoardStore.getState().taskModal).toEqual({ status: "INTAKE" });
  });

  it("includes project preset when activeProject is set", async () => {
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
        activeProject="alpha"
      />,
    );
    await userEvent.click(screen.getByTestId("kb-add-FIELD"));
    expect(useBoardStore.getState().taskModal).toEqual({
      status: "FIELD",
      project: "alpha",
    });
  });

  it("omits the project key entirely when activeProject is undefined", async () => {
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    await userEvent.click(screen.getByTestId("kb-add-FIELD"));
    const modal = useBoardStore.getState().taskModal;
    expect(modal).toEqual({ status: "FIELD" });
    expect(modal).not.toHaveProperty("project");
  });
});

// ── drag-and-drop ─────────────────────────────────────────────────────────────

describe("KanbanView — drag-and-drop", () => {
  it("writes the task id to dataTransfer on drag start", () => {
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    const setData = vi.fn();
    const card = screen.getByTestId("task-card-t1");
    fireEvent.dragStart(card, {
      dataTransfer: { setData, effectAllowed: "" },
    });
    expect(setData).toHaveBeenCalledWith("text/plain", "t1");
  });

  it("drop fires PATCH to /api/vault/board/tasks/{id} with {status: colId}", async () => {
    const stub = makeStub();
    vi.stubGlobal("fetch", stub);

    // Need a QueryClient that is already hydrated — wrap the component
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Pre-populate the cache so usePatchTask onMutate doesn't error
    const { queryKeys } = await import("#/api/keys");
    qc.setQueryData(queryKeys.board.all, BOARD_FIXTURE);

    render(
      <QueryClientProvider client={qc}>
        <KanbanView
          columns={columns}
          tasks={tasks}
          cycles={cycles}
          showOp={false}
        />
      </QueryClientProvider>,
    );

    // Drag t1 (FIELD) to REVIEW column
    const card = screen.getByTestId("task-card-t1");
    const reviewCol = screen.getByTestId("kb-col-REVIEW");

    fireEvent.dragStart(card);
    fireEvent.dragOver(reviewCol);
    fireEvent.drop(reviewCol);

    // Wait for the mutation to fire
    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter((args) => {
        const url = args[0] as string;
        const opts = args[1] as RequestInit | undefined;
        return (
          typeof url === "string" &&
          url.includes("/tasks/t1") &&
          opts?.method === "PATCH"
        );
      });
      expect(patchCalls.length).toBeGreaterThan(0);
      const opts = patchCalls[0][1] as RequestInit;
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body).toEqual({ status: "REVIEW" });
    });
  });

  it("same-column drop fires NO PATCH request", async () => {
    const stub = makeStub();
    vi.stubGlobal("fetch", stub);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { queryKeys } = await import("#/api/keys");
    qc.setQueryData(queryKeys.board.all, BOARD_FIXTURE);

    render(
      <QueryClientProvider client={qc}>
        <KanbanView
          columns={columns}
          tasks={tasks}
          cycles={cycles}
          showOp={false}
        />
      </QueryClientProvider>,
    );

    // Drag t1 (FIELD) and drop it back onto its own FIELD column
    const card = screen.getByTestId("task-card-t1");
    const fieldCol = screen.getByTestId("kb-col-FIELD");

    fireEvent.dragStart(card);
    fireEvent.dragOver(fieldCol);
    fireEvent.drop(fieldCol);

    // Flush microtasks so any (incorrect) mutation would have fired
    await Promise.resolve();
    await Promise.resolve();

    const patchCalls = stub.mock.calls.filter((args) => {
      const opts = args[1] as RequestInit | undefined;
      return opts?.method === "PATCH";
    });
    expect(patchCalls).toHaveLength(0);
  });

  it("dragEnd clears the drag state (card no longer has dragging style)", () => {
    wrap(
      <KanbanView
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    const card = screen.getByTestId("task-card-t1");
    fireEvent.dragStart(card);
    // During drag the card should have reduced opacity
    // (isDragging=true → style opacity:0.35)
    expect(card).toHaveStyle({ opacity: "0.35" });

    fireEvent.dragEnd(card);
    // After dragEnd, opacity should be gone
    expect(card).not.toHaveStyle({ opacity: "0.35" });
  });
});
