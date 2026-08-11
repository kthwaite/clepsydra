/**
 * TimelineView tests.
 *
 * Fixture strategy:
 *   BOARD_FIXTURE tasks have no `due` date → all unscheduled.
 *   TL_FIXTURE_* provide dated tasks/cycles for timeline-specific assertions.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCycle, BoardOperation, BoardTask } from "#/api/board";
import { useBoardStore } from "#/store/board";
import { TimelineView } from "../TimelineView";
import { parseDay, pct, windowOf } from "../timeline-math";
import { BOARD_FIXTURE, stubBoardFetch } from "./fixtures";

// ── fixture helpers ───────────────────────────────────────────────────────────

/** Two cycles with real dates — used for window + band tests. */
const TL_CYCLES: BoardCycle[] = [
  {
    id: "cyc-tl-1",
    code: "C-01",
    label: "Cycle 01",
    state: "ACTIVE",
    path: "tasks/c-01.md",
    start: "2026-05-26",
    end: "2026-06-08",
    goal: null,
  },
  {
    id: "cyc-tl-2",
    code: "C-02",
    label: "Cycle 02",
    state: "PLANNED",
    path: "tasks/c-02.md",
    start: "2026-06-09",
    end: "2026-06-22",
    goal: null,
  },
];

const TL_OPS: BoardOperation[] = [
  {
    id: "op-alpha",
    code: "OPS-1",
    name: "Operation Alpha",
    health: "GREEN",
    path: "tasks/ops-1.md",
    project: "alpha",
    lead: "Kit",
    target: "2026-Q3",
    dossier: null,
    note: null,
  },
  {
    id: "op-beta",
    code: "OPS-2",
    name: "Operation Beta",
    health: "AMBER",
    path: "tasks/ops-2.md",
    project: "beta",
    lead: "Alex",
    target: "2026-Q4",
    dossier: null,
    note: null,
  },
];

/** Scheduled task for alpha operation */
const TL_TASK_ALPHA: BoardTask = {
  id: "t-alpha-1",
  code: "TSK-0010",
  title: "Alpha Scheduled",
  status: "FIELD",
  priority: "P1",
  project: "alpha",
  cycle: "C-01",
  due: "2026-06-08",
  start: "2026-06-01",
  tags: [],
  checks: [],
  path: "tasks/t-alpha-1.md",
  updated_at: "2026-06-01T00:00:00Z",
};

/** Scheduled task for beta operation */
const TL_TASK_BETA: BoardTask = {
  id: "t-beta-1",
  code: "TSK-0011",
  title: "Beta Scheduled",
  status: "TRIAGE",
  priority: "P2",
  project: "beta",
  cycle: "C-02",
  due: "2026-06-22",
  start: "2026-06-15",
  tags: [],
  checks: [],
  path: "tasks/t-beta-1.md",
  updated_at: "2026-06-02T00:00:00Z",
};

/** Unscheduled task (no due) */
const TL_TASK_UNSCHEDULED: BoardTask = {
  id: "t-unsched",
  code: "TSK-0012",
  title: "Unscheduled Task",
  status: "INTAKE",
  priority: "P3",
  project: "alpha",
  cycle: null,
  due: undefined,
  tags: [],
  checks: [],
  path: "tasks/t-unsched.md",
  updated_at: "2026-06-03T00:00:00Z",
};

/** UNFILED scheduled task (no project) */
const TL_TASK_UNFILED: BoardTask = {
  id: "t-unfiled",
  code: "TSK-0013",
  title: "Unfiled Scheduled",
  status: "INTAKE",
  priority: "P3",
  project: null,
  cycle: null,
  due: "2026-06-10",
  tags: [],
  checks: [],
  path: "tasks/t-unfiled.md",
  updated_at: "2026-06-04T00:00:00Z",
};

/** HOLD scheduled task */
const TL_TASK_HOLD: BoardTask = {
  id: "t-hold",
  code: "TSK-0014",
  title: "Hold Task",
  status: "INTAKE",
  priority: "P1",
  project: "alpha",
  cycle: "C-01",
  due: "2026-06-08",
  hold: "awaiting review",
  tags: [],
  checks: [],
  path: "tasks/t-hold.md",
  updated_at: "2026-06-01T00:00:00Z",
};

// ── render wrapper ────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// ── setup/teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
  useBoardStore.setState({
    mode: "timeline",
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
// Empty state
// ══════════════════════════════════════════════════════════════════════════════

describe("TimelineView — empty state", () => {
  it("shows empty state when cycles have no dates", () => {
    const undatedCycles: BoardCycle[] = [
      { ...TL_CYCLES[0], start: null, end: null },
    ];
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={undatedCycles}
      />,
    );
    expect(screen.getByTestId("tl-empty")).toBeInTheDocument();
    expect(screen.getByTestId("tl-empty").textContent).toContain(
      "NOTHING SCHEDULED",
    );
  });

  it("shows empty state when no tasks have a due date", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_UNSCHEDULED]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    expect(screen.getByTestId("tl-empty")).toBeInTheDocument();
  });

  it("shows empty state with empty tasks array", () => {
    wrap(<TimelineView tasks={[]} operations={TL_OPS} cycles={TL_CYCLES} />);
    expect(screen.getByTestId("tl-empty")).toBeInTheDocument();
  });

  it("shows empty state with empty cycles array", () => {
    wrap(
      <TimelineView tasks={[TL_TASK_ALPHA]} operations={TL_OPS} cycles={[]} />,
    );
    expect(screen.getByTestId("tl-empty")).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Axis bands
// ══════════════════════════════════════════════════════════════════════════════

describe("TimelineView — axis bands", () => {
  it("renders a band per dated cycle", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    expect(screen.getByTestId("tl-band-C-01")).toBeInTheDocument();
    expect(screen.getByTestId("tl-band-C-02")).toBeInTheDocument();
  });

  it("ACTIVE cycle band shows cycle code in the band label", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const band = screen.getByTestId("tl-band-C-01");
    expect(band.textContent).toContain("C-01");
  });

  it("ACTIVE cycle band has ACTIVE class", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const band = screen.getByTestId("tl-band-C-01");
    expect(band.className).toContain("ACTIVE");
  });

  it("PLANNED cycle band has PLANNED class", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const band = screen.getByTestId("tl-band-C-02");
    expect(band.className).toContain("PLANNED");
  });

  it("bands with undated cycles are skipped", () => {
    const mixedCycles: BoardCycle[] = [
      ...TL_CYCLES,
      {
        id: "cyc-nodates",
        code: "C-ND",
        label: "No Dates",
        state: "PLANNED",
        path: "tasks/c-nd.md",
        start: null,
        end: null,
        goal: null,
      },
    ];
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={mixedCycles}
      />,
    );
    expect(screen.queryByTestId("tl-band-C-ND")).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Operation grouping
// ══════════════════════════════════════════════════════════════════════════════

describe("TimelineView — operation groups", () => {
  it("renders only groups that have at least one scheduled task", () => {
    // Only alpha has a due date
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA, TL_TASK_UNSCHEDULED]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    expect(screen.getByTestId("tl-grp-alpha")).toBeInTheDocument();
    // beta has no scheduled tasks
    expect(screen.queryByTestId("tl-grp-beta")).not.toBeInTheDocument();
  });

  it("renders group header with op code and name", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const grp = screen.getByTestId("tl-grp-alpha");
    expect(grp.textContent).toContain("OPS-1");
    expect(grp.textContent).toContain("Operation Alpha");
  });

  it("renders both groups when both ops have scheduled tasks", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA, TL_TASK_BETA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    expect(screen.getByTestId("tl-grp-alpha")).toBeInTheDocument();
    expect(screen.getByTestId("tl-grp-beta")).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// UNFILED group
// ══════════════════════════════════════════════════════════════════════════════

describe("TimelineView — UNFILED group", () => {
  it("renders UNFILED group for tasks with null project", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA, TL_TASK_UNFILED]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    expect(screen.getByTestId("tl-grp-UNFILED")).toBeInTheDocument();
  });

  it("UNFILED group header shows UNFILED code and label", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_UNFILED]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const grp = screen.getByTestId("tl-grp-UNFILED");
    expect(grp.textContent).toContain("UNFILED");
  });

  it("does not render UNFILED group when there are no unfiled scheduled tasks", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    expect(screen.queryByTestId("tl-grp-UNFILED")).not.toBeInTheDocument();
  });

  it("UNFILED group appears after named operation groups", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA, TL_TASK_UNFILED]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const body = screen.getByTestId("tl-root");
    const alphaGrp = screen.getByTestId("tl-grp-alpha");
    const unfiledGrp = screen.getByTestId("tl-grp-UNFILED");
    // UNFILED should appear after alpha
    const allGrps = body.querySelectorAll("[data-testid^='tl-grp-']");
    const alphaIdx = Array.from(allGrps).indexOf(alphaGrp);
    const unfiledIdx = Array.from(allGrps).indexOf(unfiledGrp);
    expect(unfiledIdx).toBeGreaterThan(alphaIdx);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Bar positioning
// ══════════════════════════════════════════════════════════════════════════════

describe("TimelineView — bar positioning", () => {
  it("bar left% is computed from pct(taskStart, window)", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );

    const win = windowOf(TL_CYCLES)!;
    const s = parseDay("2026-06-01")!;
    const e = parseDay("2026-06-08")!;
    const expectedLeft = pct(s, win);
    const expectedWidth = Math.max(2.5, pct(e, win) - expectedLeft);

    const bar = screen.getByTestId("tl-bar-t-alpha-1");
    const style = window.getComputedStyle(bar);

    // jsdom doesn't resolve CSS percentages in getComputedStyle, so check
    // the inline style attribute string directly.
    const styleAttr = bar.getAttribute("style") ?? "";
    expect(styleAttr).toContain(`left: ${expectedLeft}%`);
    expect(styleAttr).toContain(`width: ${expectedWidth}%`);

    void style; // suppress unused warning
  });

  it("bar width is at least 2.5% (min-width guard)", () => {
    // Create a task with start === due (zero-duration range)
    const pointTask: BoardTask = {
      ...TL_TASK_ALPHA,
      id: "t-point",
      due: "2026-06-01",
      start: "2026-06-01",
    };
    wrap(
      <TimelineView
        tasks={[pointTask]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const bar = screen.getByTestId("tl-bar-t-point");
    const styleAttr = bar.getAttribute("style") ?? "";
    // Extract width value
    const widthMatch = /width:\s*([\d.]+)%/.exec(styleAttr);
    expect(widthMatch).not.toBeNull();
    expect(parseFloat(widthMatch![1])).toBeGreaterThanOrEqual(2.5);
  });

  it("bar has correct status class", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const bar = screen.getByTestId("tl-bar-t-alpha-1");
    expect(bar.className).toContain("FIELD");
  });

  it("positions bars absolutely inside a relative track", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const bar = screen.getByTestId(`tl-bar-${TL_TASK_ALPHA.id}`);
    expect(bar.className).toContain("absolute");
    expect(bar.parentElement?.className).toContain("relative");
  });

  it("bar has hold class when task.hold is set", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_HOLD]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const bar = screen.getByTestId("tl-bar-t-hold");
    expect(bar.className).toContain("hold");
  });

  it("bar shows code and status label text", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const bar = screen.getByTestId("tl-bar-t-alpha-1");
    expect(bar.textContent).toContain("TSK-0010");
    expect(bar.textContent).toContain("IN-FIELD");
  });

  it("bar has title attribute set to task title", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const bar = screen.getByTestId("tl-bar-t-alpha-1");
    expect(bar).toHaveAttribute("title", "Alpha Scheduled");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Bar click → editTaskId
// ══════════════════════════════════════════════════════════════════════════════

describe("TimelineView — bar click", () => {
  it("clicking a bar sets editTaskId via store", async () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const bar = screen.getByTestId("tl-bar-t-alpha-1");
    await userEvent.click(bar);
    expect(useBoardStore.getState().editTaskId).toBe("t-alpha-1");
  });

  it("clicking a bar calls onEditTask override when provided", async () => {
    const spy = vi.fn();
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
        onEditTask={spy}
      />,
    );
    const bar = screen.getByTestId("tl-bar-t-alpha-1");
    await userEvent.click(bar);
    expect(spy).toHaveBeenCalledWith("t-alpha-1");
    // store should NOT be updated when override is provided
    expect(useBoardStore.getState().editTaskId).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Unscheduled footer
// ══════════════════════════════════════════════════════════════════════════════

describe("TimelineView — unscheduled footer", () => {
  it("shows footer when there are unscheduled tasks", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA, TL_TASK_UNSCHEDULED]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    expect(screen.getByTestId("tl-foot")).toBeInTheDocument();
    expect(screen.getByTestId("tl-foot").textContent).toContain(
      "01 UNSCHEDULED",
    );
  });

  it("zero-pads the unscheduled count", () => {
    const twoUnscheduled: BoardTask[] = [
      TL_TASK_UNSCHEDULED,
      {
        ...TL_TASK_UNSCHEDULED,
        id: "t-unsched-2",
        code: "TSK-0099",
        due: undefined,
      },
    ];
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA, ...twoUnscheduled]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    expect(screen.getByTestId("tl-foot").textContent).toContain(
      "02 UNSCHEDULED",
    );
  });

  it("footer shows descriptive subtitle", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA, TL_TASK_UNSCHEDULED]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    expect(screen.getByTestId("tl-foot").textContent).toContain("no due date");
  });

  it("does not render footer when all tasks are scheduled", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    expect(screen.queryByTestId("tl-foot")).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// UNFILED — non-null unmatched project
// ══════════════════════════════════════════════════════════════════════════════

describe("TimelineView — UNFILED non-null project", () => {
  it("task with non-null project not matching any operation lands in UNFILED", () => {
    const orphanTask: BoardTask = {
      ...TL_TASK_ALPHA,
      id: "t-orphan",
      code: "TSK-0099",
      project: "orphan-unknown-project",
      due: "2026-06-10",
    };
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA, orphanTask]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    // alpha group exists (TL_TASK_ALPHA matches OPS-1)
    expect(screen.getByTestId("tl-grp-alpha")).toBeInTheDocument();
    // orphan-unknown-project doesn't match any op → UNFILED group
    expect(screen.getByTestId("tl-grp-UNFILED")).toBeInTheDocument();
    expect(screen.getByTestId("tl-grp-UNFILED").textContent).toContain(
      "UNFILED",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Gridlines per cycle
// ══════════════════════════════════════════════════════════════════════════════

describe("TimelineView — gridlines per row", () => {
  it("renders one gridline per dated cycle in each task row", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const row = screen.getByTestId("tl-row-t-alpha-1");
    // TL_CYCLES has 2 cycles with start dates → 2 gridline spans per row
    const gridlines = row.querySelectorAll(".tl-grid");
    expect(gridlines.length).toBe(TL_CYCLES.length);
  });

  it("gridlines have a left% style derived from cycle start", () => {
    wrap(
      <TimelineView
        tasks={[TL_TASK_ALPHA]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );
    const row = screen.getByTestId("tl-row-t-alpha-1");
    const gridlines = Array.from(row.querySelectorAll(".tl-grid"));
    // Every gridline must have a left style set
    for (const gl of gridlines) {
      const styleAttr = gl.getAttribute("style") ?? "";
      expect(styleAttr).toMatch(/left:/);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Row order within group by start date
// ══════════════════════════════════════════════════════════════════════════════

describe("TimelineView — row order within group by start", () => {
  it("tasks within a group are sorted by start ascending", () => {
    // Later start date first in input — should come second in rendered output
    const laterTask: BoardTask = {
      ...TL_TASK_ALPHA,
      id: "t-alpha-later",
      code: "TSK-0020",
      due: "2026-06-22",
      start: "2026-06-15", // later than TL_TASK_ALPHA's start (2026-06-01)
    };
    const earlierTask = TL_TASK_ALPHA; // start: 2026-06-01

    wrap(
      <TimelineView
        // Pass laterTask first in the array — the view should still sort it after
        tasks={[laterTask, earlierTask]}
        operations={TL_OPS}
        cycles={TL_CYCLES}
      />,
    );

    const grp = screen.getByTestId("tl-grp-alpha");
    const rows = grp.querySelectorAll("[data-testid^='tl-row-']");
    expect(rows.length).toBe(2);
    // earlier start should appear first
    expect(rows[0].getAttribute("data-testid")).toBe("tl-row-t-alpha-1");
    expect(rows[1].getAttribute("data-testid")).toBe("tl-row-t-alpha-later");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TaskingScreen integration — timeline mode
// ══════════════════════════════════════════════════════════════════════════════

import type { BoardResponse } from "#/api/board";
import { TaskingScreen } from "../TaskingScreen";

/** Augmented board fixture with dated tasks for timeline integration tests. */
const TL_BOARD: BoardResponse = {
  ...BOARD_FIXTURE,
  cycles: TL_CYCLES,
  tasks: [
    {
      ...BOARD_FIXTURE.tasks[0],
      due: "2026-06-08",
      start: "2026-06-01",
    },
    {
      ...BOARD_FIXTURE.tasks[2],
      due: "2026-06-22",
      start: "2026-06-15",
    },
    // t2, t4, t5 remain without due dates
    BOARD_FIXTURE.tasks[1],
    BOARD_FIXTURE.tasks[3],
    BOARD_FIXTURE.tasks[4],
  ],
};

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TaskingScreen />
    </QueryClientProvider>,
  );
}

describe("TaskingScreen integration — timeline mode", () => {
  it("renders TimelineView root in timeline mode", async () => {
    useBoardStore.setState({ mode: "timeline" });
    stubBoardFetch(TL_BOARD);
    renderScreen();
    await screen.findByText("TASKING BOARD");
    expect(screen.getByTestId("tl-root")).toBeInTheDocument();
  });

  it("ALL ops: groups by all operations with scheduled tasks", async () => {
    useBoardStore.setState({ mode: "timeline", opFilter: "ALL" });
    stubBoardFetch(TL_BOARD);
    renderScreen();
    await screen.findByText("TASKING BOARD");
    // t1 → alpha; t3 → beta
    expect(screen.getByTestId("tl-grp-alpha")).toBeInTheDocument();
    expect(screen.getByTestId("tl-grp-beta")).toBeInTheDocument();
  });

  it("single op filter: only that op's tasks are shown", async () => {
    useBoardStore.setState({ mode: "timeline", opFilter: "alpha" });
    stubBoardFetch(TL_BOARD);
    renderScreen();
    await screen.findByText("TASKING BOARD");
    expect(screen.getByTestId("tl-grp-alpha")).toBeInTheDocument();
    expect(screen.queryByTestId("tl-grp-beta")).not.toBeInTheDocument();
  });

  it("shows empty state when mode is timeline but no tasks have due dates", async () => {
    useBoardStore.setState({ mode: "timeline" });
    stubBoardFetch(BOARD_FIXTURE); // no due dates in base fixture
    renderScreen();
    await screen.findByText("TASKING BOARD");
    expect(screen.getByTestId("tl-empty")).toBeInTheDocument();
  });

  it("shows no BodyPlaceholder placeholder text in timeline mode", async () => {
    useBoardStore.setState({ mode: "timeline" });
    stubBoardFetch(TL_BOARD);
    renderScreen();
    await screen.findByText("TASKING BOARD");
    expect(screen.queryByText(/COMING SOON/)).not.toBeInTheDocument();
  });

  it("UNFILED opFilter: only unfiled tasks are shown (no named-op groups)", async () => {
    // TL_BOARD has t1 (alpha, due) and t3 (beta, due); t4 is null-project/undated.
    // Add a dated unfiled task to TL_BOARD so the timeline is non-empty.
    const unfiledDated: BoardTask = {
      id: "t-unfiled-dated",
      code: "TSK-9999",
      title: "Unfiled Dated",
      status: "INTAKE",
      priority: "P3",
      project: null,
      cycle: null,
      due: "2026-06-10",
      start: "2026-06-08",
      tags: [],
      checks: [],
      path: "tasks/t-unfiled-dated.md",
      updated_at: "2026-06-05T00:00:00Z",
    };
    const boardWithUnfiled: BoardResponse = {
      ...TL_BOARD,
      tasks: [...TL_BOARD.tasks, unfiledDated],
    };
    useBoardStore.setState({ mode: "timeline", opFilter: "UNFILED" });
    stubBoardFetch(boardWithUnfiled);
    renderScreen();
    await screen.findByText("TASKING BOARD");
    // Unfiled group should exist
    expect(screen.getByTestId("tl-grp-UNFILED")).toBeInTheDocument();
    // Named operation groups should NOT exist (filtered out by TaskingScreen)
    expect(screen.queryByTestId("tl-grp-alpha")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tl-grp-beta")).not.toBeInTheDocument();
  });
});
