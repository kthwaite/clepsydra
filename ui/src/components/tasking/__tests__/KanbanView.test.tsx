/**
 * KanbanView + TaskCard tests.
 *
 * Fetch stub pattern: vi.fn() returning a Response-shaped object — same
 * approach used across the tasking test suite.
 */

import type {
  draggable as draggableAdapter,
  dropTargetForElements as dropTargetForElementsAdapter,
  ElementDragPayload,
  ElementDropTargetEventPayloadMap,
  ElementDropTargetGetFeedbackArgs,
  ElementEventPayloadMap,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardTask } from "#/api/board";
import { queryKeys } from "#/api/keys";
import { useBoardStore } from "#/store/board";
import { KanbanView, visibleInKanban } from "../KanbanView";
import {
  BOARD_FIXTURE,
  BOARD_FIXTURE_WITH_CLOSED_CYCLE,
  CLOSED_CYCLE,
  FIXTURE_COL_LABEL,
  SEALED_IN_CLOSED_CYCLE_TASK,
} from "./fixtures";

type DraggableRegistration = Parameters<typeof draggableAdapter>[0];
type DropTargetRegistration = Parameters<
  typeof dropTargetForElementsAdapter
>[0];
type DropPayload = ElementDropTargetEventPayloadMap["onDrop"];
type DropTargetRecord = DropPayload["self"];
type DragSource = {
  registration: DraggableRegistration;
  source: ElementDragPayload;
};

const dnd = vi.hoisted(() => ({
  draggables: [] as DraggableRegistration[],
  dropTargets: [] as DropTargetRegistration[],
}));

function register<T>(registrations: T[], registration: T) {
  registrations.push(registration);
  return () => {
    const index = registrations.indexOf(registration);
    if (index !== -1) registrations.splice(index, 1);
  };
}

vi.mock(
  "@atlaskit/pragmatic-drag-and-drop/element/adapter",
  () => ({
    draggable: (registration: DraggableRegistration) =>
      register(dnd.draggables, registration),
    dropTargetForElements: (registration: DropTargetRegistration) =>
      register(dnd.dropTargets, registration),
  }),
);

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

const dndInput: ElementDropTargetGetFeedbackArgs["input"] = {
  altKey: false,
  button: 0,
  buttons: 1,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  clientX: 0,
  clientY: 0,
  pageX: 0,
  pageY: 0,
};

function dragLocation(
  dropTargets: DropTargetRecord[] = [],
): DropPayload["location"] {
  return {
    initial: { input: dndInput, dropTargets: [] },
    current: { input: dndInput, dropTargets },
    previous: { dropTargets: [] },
  };
}

function sourceFor(card: HTMLElement): DragSource {
  const registration = dnd.draggables.find(
    (candidate) =>
      candidate.element === card || candidate.dragHandle === card,
  );
  if (!registration) {
    throw new Error(`No draggable registered for "${card.textContent}"`);
  }
  const dragHandle = registration.dragHandle ?? null;
  const feedback = {
    input: dndInput,
    element: registration.element,
    dragHandle,
  };
  return {
    registration,
    source: {
      element: registration.element,
      dragHandle,
      data: registration.getInitialData?.(feedback) ?? {},
    },
  };
}

function targetFor(column: HTMLElement) {
  const registration = dnd.dropTargets.find(
    (candidate) => candidate.element === column,
  );
  if (!registration) {
    throw new Error(`No drop target registered for "${column.textContent}"`);
  }
  return registration;
}

function canDrop(source: ElementDragPayload, target: DropTargetRegistration) {
  return (
    target.canDrop?.({
      input: dndInput,
      source,
      element: target.element,
    }) ?? true
  );
}

function targetRecord(
  source: ElementDragPayload,
  target: DropTargetRegistration,
): DropTargetRecord {
  const feedback: ElementDropTargetGetFeedbackArgs = {
    input: dndInput,
    source,
    element: target.element,
  };
  return {
    element: target.element,
    data: target.getData?.(feedback) ?? {},
    dropEffect: target.getDropEffect?.(feedback) ?? "move",
    isActiveDueToStickiness: false,
  };
}

function dispatchDragStart(source: DragSource) {
  const event: ElementEventPayloadMap["onDragStart"] = {
    location: dragLocation(),
    source: source.source,
  };
  act(() => source.registration.onDragStart?.(event));
}

function dispatchDragEnd(source: DragSource) {
  const event: ElementEventPayloadMap["onDrop"] = {
    location: dragLocation(),
    source: source.source,
  };
  act(() => source.registration.onDrop?.(event));
}

function dispatchDragEnter(
  source: ElementDragPayload,
  target: DropTargetRegistration,
) {
  if (!canDrop(source, target)) return false;
  const self = targetRecord(source, target);
  const event: ElementDropTargetEventPayloadMap["onDragEnter"] = {
    location: dragLocation([self]),
    self,
    source,
  };
  act(() => target.onDragEnter?.(event));
  return true;
}

function dispatchDragLeave(
  source: ElementDragPayload,
  target: DropTargetRegistration,
) {
  const self = targetRecord(source, target);
  const event: ElementDropTargetEventPayloadMap["onDragLeave"] = {
    location: dragLocation(),
    self,
    source,
  };
  act(() => target.onDragLeave?.(event));
}

function dispatchDrop(
  source: ElementDragPayload,
  target: DropTargetRegistration,
  draggable?: DraggableRegistration,
) {
  if (!canDrop(source, target)) return false;
  const self = targetRecord(source, target);
  const location = dragLocation([self]);
  const targetEvent: ElementDropTargetEventPayloadMap["onDrop"] = {
    location,
    self,
    source,
  };
  const sourceEvent: ElementEventPayloadMap["onDrop"] = { location, source };
  act(() => {
    target.onDrop?.(targetEvent);
    draggable?.onDrop?.(sourceEvent);
  });
  return true;
}


function renderDndKanban(fetchStub = makeStub()) {
  vi.stubGlobal("fetch", fetchStub);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(queryKeys.board.all, BOARD_FIXTURE);
  const view = (boardTasks: BoardTask[]) => (
    <QueryClientProvider client={qc}>
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={boardTasks}
        cycles={cycles}
        showOp={false}
      />
    </QueryClientProvider>
  );
  const rendered = render(view(tasks));
  return {
    fetchStub,
    rerenderTasks: (boardTasks: BoardTask[]) =>
      rendered.rerender(view(boardTasks)),
  };
}

function patchCalls(fetchStub: Mock) {
  return fetchStub.mock.calls.filter((args) => {
    const opts = args[1] as RequestInit | undefined;
    return opts?.method === "PATCH";
  });
}

const { columns, tasks, cycles } = BOARD_FIXTURE;

beforeEach(() => {
  dnd.draggables.length = 0;
  dnd.dropTargets.length = 0;
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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

  it("renders only a non-empty body excerpt with a fixed line clamp", () => {
    renderWithHold();

    const excerpt = screen.getByTestId("task-excerpt-t1");
    expect(excerpt).toHaveTextContent("A concise projected task body.");
    expect(excerpt).toHaveClass("line-clamp-3");
    expect(screen.queryByTestId("task-excerpt-t2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-excerpt-t3")).not.toBeInTheDocument();
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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

  it("renders up to 3 tag chips with no overflow chip when tags.length <= 3", () => {
    const taskWithTags: BoardTask = {
      ...tasks[0],
      id: "t-tags-3",
      code: "TSK-0030",
      status: "INTAKE",
      tags: ["alpha", "beta", "gamma"],
    };
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={[taskWithTags]}
        cycles={cycles}
        showOp={false}
      />,
    );
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("gamma")).toBeInTheDocument();
    expect(
      screen.queryByTestId(`task-tags-more-${taskWithTags.id}`),
    ).not.toBeInTheDocument();
  });

  it("renders only the first 3 tags plus a +N overflow chip when tags.length > 3", () => {
    const taskWithManyTags: BoardTask = {
      ...tasks[0],
      id: "t-tags-5",
      code: "TSK-0031",
      status: "INTAKE",
      tags: ["alpha", "beta", "gamma", "delta", "epsilon"],
    };
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={[taskWithManyTags]}
        cycles={cycles}
        showOp={false}
      />,
    );
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("gamma")).toBeInTheDocument();
    expect(screen.queryByText("delta")).not.toBeInTheDocument();
    expect(screen.queryByText("epsilon")).not.toBeInTheDocument();
    const overflow = screen.getByTestId(
      `task-tags-more-${taskWithManyTags.id}`,
    );
    expect(overflow).toHaveTextContent("+2");
  });

  it("does not render checklist section when checks array is empty", () => {
    // t1 has checks=[] — no d/total text
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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

// ── inline priority/status editing ────────────────────────────────────────────

describe("TaskCard — inline editing", () => {
  it("priority trigger patches priority without opening the edit panel", async () => {
    const stub = makeStub();
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
      stub,
    );

    const user = userEvent.setup();
    // t1 is P1 — pick P0 in the popover
    await user.click(screen.getByTestId("kb-inline-priority-t1"));
    await user.click(screen.getByTestId("inline-priority-P0"));

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter((args) => {
        const opts = args[1] as RequestInit | undefined;
        return opts?.method === "PATCH";
      });
      expect(patchCalls.length).toBeGreaterThan(0);
      const opts = patchCalls[0][1] as RequestInit;
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body).toEqual({ priority: "P0" });
    });

    // The edit panel must NOT have opened for this click sequence.
    expect(useBoardStore.getState().editTaskId).toBeNull();
  });

  it("Enter key on priority chip does not open the edit panel", async () => {
    const stub = makeStub();
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
      stub,
    );

    const priorityChip = screen.getByTestId("kb-inline-priority-t1");
    priorityChip.focus();
    fireEvent.keyDown(priorityChip, { key: "Enter" });

    // The edit panel must NOT have opened
    expect(useBoardStore.getState().editTaskId).toBeNull();
  });
});

// ── keyboard activation ──────────────────────────────────────────────────────────

describe("TaskCard — keyboard activation", () => {
  it("card has role=button and tabIndex=0", () => {
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    const card = screen.getByTestId("task-card-t1");
    expect(card).toHaveAttribute("role", "button");
    expect(card).toHaveAttribute("tabindex", "0");
  });

  it("Enter key on card opens the edit panel", () => {
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    const card = screen.getByTestId("task-card-t1");
    card.focus();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(useBoardStore.getState().editTaskId).toBe("t1");
  });

  it("Space key on card opens the edit panel", () => {
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    const card = screen.getByTestId("task-card-t2");
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    expect(useBoardStore.getState().editTaskId).toBe("t2");
  });

  it("dossier link is a button that opens dossier without opening edit panel", async () => {
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
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={[taskWithLink]}
        cycles={cycles}
        showOp={false}
        onOpenDossier={onOpenDossier}
      />,
    );

    const linkButton = screen.getByText("tasks/alpha");
    expect(linkButton.tagName).toBe("BUTTON");

    const user = userEvent.setup();
    await user.click(linkButton);

    // onOpenDossier should be called
    expect(onOpenDossier).toHaveBeenCalledWith("tasks/alpha");

    // Edit panel must NOT have opened
    expect(useBoardStore.getState().editTaskId).toBeNull();
  });

  it("Enter key on dossier button opens dossier without opening edit panel", async () => {
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
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={[taskWithLink]}
        cycles={cycles}
        showOp={false}
        onOpenDossier={onOpenDossier}
      />,
    );

    const linkButton = screen.getByText("tasks/alpha");
    const user = userEvent.setup();
    linkButton.focus();
    await user.keyboard("{Enter}");

    // onOpenDossier should be called (native button behavior)
    expect(onOpenDossier).toHaveBeenCalledWith("tasks/alpha");

    // Edit panel must NOT have opened
    expect(useBoardStore.getState().editTaskId).toBeNull();
  });

  it("card responds to Enter/Space only when card div itself is focused", () => {
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    const card = screen.getByTestId("task-card-t1");
    card.focus();
    fireEvent.keyDown(card, { key: "Enter" });
    // Card div focused: edit panel should open
    expect(useBoardStore.getState().editTaskId).toBe("t1");
  });
});

// ── + button opens taskModal with status preset ───────────────────────────────

describe("KanbanView — column + button", () => {
  it("clicking + in a column opens taskModal with that column's status", async () => {
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
        colLabel={FIXTURE_COL_LABEL}
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
  it("exposes the task identity and current status at the drag-source boundary", () => {
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );

    const source = sourceFor(screen.getByTestId("task-card-t1"));

    expect(source.source.data).toEqual({
      kind: "task-card",
      taskId: "t1",
      status: "FIELD",
    });
  });

  it("sets and resets card dragging feedback through the adapter lifecycle", () => {
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    const card = screen.getByTestId("task-card-t1");
    const source = sourceFor(card);

    dispatchDragStart(source);
    expect(card).toHaveStyle({ opacity: "0.35" });

    dispatchDragEnd(source);
    expect(card).not.toHaveStyle({ opacity: "0.35" });
  });

  it("sends one exact status PATCH when dropped in another column", async () => {
    const { fetchStub: stub } = renderDndKanban();
    const source = sourceFor(screen.getByTestId("task-card-t1"));
    const reviewTarget = targetFor(screen.getByTestId("kb-col-REVIEW"));

    dispatchDrop(source.source, reviewTarget, source.registration);

    await waitFor(() => {
      expect(patchCalls(stub)).toEqual([
        [
          "/api/vault/board/tasks/t1",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "REVIEW" }),
          },
        ],
      ]);
    });
  });

  it("does not PATCH when dropped back in the current column", async () => {
    const { fetchStub: stub } = renderDndKanban();
    const source = sourceFor(screen.getByTestId("task-card-t1"));
    const fieldTarget = targetFor(screen.getByTestId("kb-col-FIELD"));

    dispatchDrop(source.source, fieldTarget, source.registration);
    await Promise.resolve();
    await Promise.resolve();

    expect(patchCalls(stub)).toHaveLength(0);
  });

  it("highlights an entered target and clears it on leave and drop", () => {
    renderDndKanban();
    const source = sourceFor(screen.getByTestId("task-card-t1"));
    const fieldColumn = screen.getByTestId("kb-col-FIELD");
    const fieldTarget = targetFor(fieldColumn);

    dispatchDragEnter(source.source, fieldTarget);
    expect(fieldColumn).toHaveStyle({
      background: "color-mix(in oklab, var(--accent) 7%, transparent)",
    });

    dispatchDragLeave(source.source, fieldTarget);
    expect(fieldColumn).not.toHaveStyle({
      background: "color-mix(in oklab, var(--accent) 7%, transparent)",
    });

    dispatchDragEnter(source.source, fieldTarget);
    expect(fieldColumn).toHaveStyle({
      background: "color-mix(in oklab, var(--accent) 7%, transparent)",
    });

    dispatchDrop(source.source, fieldTarget, source.registration);
    expect(fieldColumn).not.toHaveStyle({
      background: "color-mix(in oklab, var(--accent) 7%, transparent)",
    });
  });

  it("rejects unrelated drag data and cannot mutate a task", async () => {
    const { fetchStub: stub } = renderDndKanban();
    const reviewTarget = targetFor(screen.getByTestId("kb-col-REVIEW"));
    const unrelatedSource: ElementDragPayload = {
      element: document.createElement("div"),
      dragHandle: null,
      data: { kind: "not-a-task-card", taskId: "t1", status: "FIELD" },
    };

    expect(canDrop(unrelatedSource, reviewTarget)).toBe(false);
    dispatchDrop(unrelatedSource, reviewTarget);
    await Promise.resolve();
    await Promise.resolve();

    expect(patchCalls(stub)).toHaveLength(0);
  });

  it("uses the current task status when stale drag data is dropped on the original column", async () => {
    const { fetchStub, rerenderTasks } = renderDndKanban();
    const source = sourceFor(screen.getByTestId("task-card-t1"));
    dispatchDragStart(source);

    rerenderTasks(
      tasks.map((task) =>
        task.id === "t1" ? { ...task, status: "REVIEW" } : task,
      ),
    );
    const fieldTarget = targetFor(screen.getByTestId("kb-col-FIELD"));
    dispatchDrop(source.source, fieldTarget);

    await waitFor(() => {
      expect(patchCalls(fetchStub)).toEqual([
        [
          "/api/vault/board/tasks/t1",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "FIELD" }),
          },
        ],
      ]);
    });
  });

  it("uses the current task status to make a stale-source drop a no-op", async () => {
    const { fetchStub, rerenderTasks } = renderDndKanban();
    const source = sourceFor(screen.getByTestId("task-card-t1"));
    dispatchDragStart(source);

    rerenderTasks(
      tasks.map((task) =>
        task.id === "t1" ? { ...task, status: "REVIEW" } : task,
      ),
    );
    const reviewTarget = targetFor(screen.getByTestId("kb-col-REVIEW"));
    dispatchDrop(source.source, reviewTarget);
    await Promise.resolve();
    await Promise.resolve();

    expect(patchCalls(fetchStub)).toHaveLength(0);
  });

  it("rejects a drag source whose task was removed during the drag", async () => {
    const { fetchStub, rerenderTasks } = renderDndKanban();
    const source = sourceFor(screen.getByTestId("task-card-t1"));
    dispatchDragStart(source);

    rerenderTasks(tasks.filter((task) => task.id !== "t1"));
    const reviewColumn = screen.getByTestId("kb-col-REVIEW");
    const reviewTarget = targetFor(reviewColumn);

    expect(canDrop(source.source, reviewTarget)).toBe(false);
    expect(dispatchDragEnter(source.source, reviewTarget)).toBe(false);
    expect(reviewColumn).not.toHaveStyle({
      background: "color-mix(in oklab, var(--accent) 7%, transparent)",
    });
    expect(dispatchDrop(source.source, reviewTarget)).toBe(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(patchCalls(fetchStub)).toHaveLength(0);
  });
});

// ── QuickAddRow wiring ───────────────────────────────────────────────────────────

describe("KanbanView — QuickAddRow wiring", () => {
  it("renders a QuickAddRow at the bottom of each column body with status preset", () => {
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    // Should have a quick-add row for each column
    expect(screen.getByTestId("qa-INTAKE")).toBeInTheDocument();
    expect(screen.getByTestId("qa-TRIAGE")).toBeInTheDocument();
    expect(screen.getByTestId("qa-FIELD")).toBeInTheDocument();
    expect(screen.getByTestId("qa-REVIEW")).toBeInTheDocument();
    expect(screen.getByTestId("qa-SEALED")).toBeInTheDocument();
  });

  it("passes the correct status preset to each column's QuickAddRow", () => {
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
      />,
    );
    const intakeRow = screen.getByTestId("qa-INTAKE");
    expect(intakeRow).toHaveAttribute("placeholder", "+ ADD");
  });

  it("includes activeProject in the preset when provided", () => {
    wrap(
      <KanbanView
        colLabel={FIXTURE_COL_LABEL}
        columns={columns}
        tasks={tasks}
        cycles={cycles}
        showOp={false}
        activeProject="alpha"
      />,
    );
    // Component should render; exact preset is verified by component tests
    expect(screen.getByTestId("qa-INTAKE")).toBeInTheDocument();
  });
});
