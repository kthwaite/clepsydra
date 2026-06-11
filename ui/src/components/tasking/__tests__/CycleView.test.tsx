/**
 * CycleView tests.
 *
 * resolveCycle — pure unit tests for cycle resolution logic.
 * cycleStats   — pure unit tests for stats computation.
 * CycleView    — render/interaction tests.
 * TaskingScreen integration — cycle mode renders CycleView.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCycle, BoardTask } from "#/api/board";
import { useBoardStore } from "#/store/board";
import { CycleView, cycleStats, resolveCycle } from "../CycleView";
import { TaskingScreen } from "../TaskingScreen";
import {
  BOARD_FIXTURE,
  BOARD_FIXTURE_WITH_NO_SLUG_OP,
  stubBoardFetch,
} from "./fixtures";

// ── fixtures ──────────────────────────────────────────────────────────────────

const { cycles, tasks } = BOARD_FIXTURE;

// C-01 is ACTIVE, C-02 is PLANNED (from BOARD_FIXTURE)
const ACTIVE_CYCLE = cycles[0]; // C-01
const PLANNED_CYCLE = cycles[1]; // C-02

/** Tasks belonging to C-01 in the fixture: t1 (FIELD,P1), t3 (TRIAGE,P2), t5 (SEALED,P2) */
const C01_TASKS = tasks.filter((t) => t.cycle === "C-01");

/** A cycle with hold tasks and checks for stats testing */
const T_HOLD: BoardTask = {
  id: "th1",
  code: "TSK-9001",
  title: "Held task",
  status: "INTAKE",
  priority: "P1",
  project: "alpha",
  cycle: "C-01",
  hold: "waiting",
  tags: [],
  checks: [2, 5],
  path: "tasks/th1.md",
  updated_at: "2026-06-10T00:00:00Z",
};

const T_SEALED: BoardTask = {
  id: "ts1",
  code: "TSK-9002",
  title: "Sealed task",
  status: "SEALED",
  priority: "P2",
  project: "alpha",
  cycle: "C-01",
  tags: [],
  checks: [3, 3],
  path: "tasks/ts1.md",
  updated_at: "2026-06-10T00:00:00Z",
};

const T_FIELD: BoardTask = {
  id: "tf1",
  code: "TSK-9003",
  title: "Field task",
  status: "FIELD",
  priority: "P2",
  project: "alpha",
  cycle: "C-01",
  tags: [],
  checks: [],
  path: "tasks/tf1.md",
  updated_at: "2026-06-10T00:00:00Z",
};

// ── BACKLOG pseudo-cycle ──────────────────────────────────────────────────────

const BACKLOG_PSEUDO = {
  code: "BACKLOG",
  label: "BACKLOG",
  state: "OPEN",
  start: null,
  end: null,
  goal: "Uncommitted tasking — not yet pulled into a cycle.",
} as const;

// ════════════════════════════════════════════════════════════════════════════
// resolveCycle — pure unit tests
// ════════════════════════════════════════════════════════════════════════════

describe("resolveCycle", () => {
  it("explicit cycle code → that cycle", () => {
    const result = resolveCycle("C-02", cycles);
    expect(result.code).toBe("C-02");
    expect(result.label).toBe("Cycle 02");
  });

  it("BACKLOG sentinel → backlog pseudo-cycle", () => {
    const result = resolveCycle("BACKLOG", cycles);
    expect(result.code).toBe("BACKLOG");
    expect(result.label).toBe("BACKLOG");
    expect(result.goal).toMatch(/Uncommitted/);
  });

  it('empty string "" → active cycle when one exists', () => {
    const result = resolveCycle("", cycles);
    expect(result.code).toBe("C-01"); // C-01 is ACTIVE
  });

  it("stale/no-match code → active cycle", () => {
    const result = resolveCycle("C-GHOST", cycles);
    expect(result.code).toBe("C-01");
  });

  it("no cycles at all → backlog pseudo-cycle", () => {
    const result = resolveCycle("", []);
    expect(result.code).toBe("BACKLOG");
  });

  it("no cycles, BACKLOG sentinel → backlog pseudo-cycle", () => {
    const result = resolveCycle("BACKLOG", []);
    expect(result.code).toBe("BACKLOG");
  });

  it("no active cycle + stale code → first cycle", () => {
    const allPlanned: BoardCycle[] = cycles.map((c) => ({
      ...c,
      state: "PLANNED",
    }));
    const result = resolveCycle("C-GHOST", allPlanned);
    expect(result.code).toBe("C-01"); // first in array
  });

  it("no active cycle + empty string → first cycle", () => {
    const allClosed: BoardCycle[] = cycles.map((c) => ({
      ...c,
      state: "CLOSED",
    }));
    const result = resolveCycle("", allClosed);
    expect(result.code).toBe("C-01");
  });

  it("no active cycle, no cycles at all, stale code → backlog pseudo", () => {
    const result = resolveCycle("C-X", []);
    expect(result.code).toBe("BACKLOG");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// cycleStats — pure unit tests
// ════════════════════════════════════════════════════════════════════════════

describe("cycleStats", () => {
  it("zero items → all zeros and zero pct", () => {
    const s = cycleStats([]);
    expect(s).toEqual({
      committed: 0,
      sealed: 0,
      field: 0,
      hold: 0,
      checkDone: 0,
      checkTot: 0,
      pct: 0,
    });
  });

  it("counts committed = total items", () => {
    const s = cycleStats([T_FIELD, T_SEALED]);
    expect(s.committed).toBe(2);
  });

  it("counts sealed = SEALED status tasks", () => {
    const s = cycleStats([T_FIELD, T_SEALED]);
    expect(s.sealed).toBe(1);
  });

  it("counts field = FIELD status tasks", () => {
    const s = cycleStats([T_FIELD, T_SEALED]);
    expect(s.field).toBe(1);
  });

  it("counts hold = tasks with hold set", () => {
    const s = cycleStats([T_HOLD, T_FIELD]);
    expect(s.hold).toBe(1);
  });

  it("sums checkDone and checkTot across items", () => {
    const s = cycleStats([T_HOLD, T_SEALED]); // checks: [2,5] + [3,3]
    expect(s.checkDone).toBe(5);
    expect(s.checkTot).toBe(8);
  });

  it("tasks with empty checks contribute zero to sums", () => {
    const s = cycleStats([T_FIELD]); // checks: []
    expect(s.checkDone).toBe(0);
    expect(s.checkTot).toBe(0);
  });

  it("pct = round(sealed/committed*100)", () => {
    const s = cycleStats([T_SEALED, T_FIELD, T_FIELD]); // 1 sealed / 3 committed
    expect(s.pct).toBe(33); // Math.round(1/3*100)
  });

  it("pct = 0 when committed = 0 (no division by zero)", () => {
    const s = cycleStats([]);
    expect(s.pct).toBe(0);
  });

  it("pct = 100 when all tasks are sealed", () => {
    const s = cycleStats([T_SEALED, { ...T_SEALED, id: "ts2" }]);
    expect(s.pct).toBe(100);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CycleView — render / interaction tests
// ════════════════════════════════════════════════════════════════════════════

beforeEach(() => {
  useBoardStore.setState({
    mode: "cycle",
    opFilter: "ALL",
    cycleSel: "C-01",
    railOpen: true,
    editTaskId: null,
    taskModal: null,
    cycleModal: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// helper
function renderCycleView(
  cycle: BoardCycle | typeof BACKLOG_PSEUDO = ACTIVE_CYCLE,
  items: BoardTask[] = C01_TASKS,
) {
  return render(<CycleView cycle={cycle} tasks={items} />);
}

// ── action buttons per cycle state ────────────────────────────────────────────

describe("CycleView — action buttons per state", () => {
  it("PLANNED cycle shows OPEN CYCLE button", () => {
    renderCycleView(PLANNED_CYCLE, []);
    expect(
      screen.getByRole("button", { name: /OPEN CYCLE/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /SEAL CYCLE/i }),
    ).not.toBeInTheDocument();
  });

  it("ACTIVE cycle shows SEAL CYCLE button", () => {
    renderCycleView(ACTIVE_CYCLE, []);
    expect(
      screen.getByRole("button", { name: /SEAL CYCLE/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /OPEN CYCLE/i }),
    ).not.toBeInTheDocument();
  });

  it("CLOSED cycle shows static CYCLE SEALED tag (no buttons)", () => {
    const closed = { ...ACTIVE_CYCLE, state: "CLOSED" };
    renderCycleView(closed, []);
    expect(screen.getByText(/CYCLE SEALED/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /SEAL CYCLE|OPEN CYCLE/i }),
    ).not.toBeInTheDocument();
  });

  it("BACKLOG pseudo-cycle shows no action buttons", () => {
    renderCycleView(BACKLOG_PSEUDO, []);
    expect(
      screen.queryByRole("button", { name: /OPEN CYCLE|SEAL CYCLE/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/CYCLE SEALED/)).not.toBeInTheDocument();
  });

  it("PLANNED OPEN button calls openCycleModal with kind:open and cycleId", async () => {
    renderCycleView(PLANNED_CYCLE, []);
    await userEvent.click(screen.getByRole("button", { name: /OPEN CYCLE/i }));
    expect(useBoardStore.getState().cycleModal).toEqual({
      kind: "open",
      cycleId: PLANNED_CYCLE.id,
    });
  });

  it("ACTIVE SEAL button calls openCycleModal with kind:seal and cycleId", async () => {
    renderCycleView(ACTIVE_CYCLE, []);
    await userEvent.click(screen.getByRole("button", { name: /SEAL CYCLE/i }));
    expect(useBoardStore.getState().cycleModal).toEqual({
      kind: "seal",
      cycleId: ACTIVE_CYCLE.id,
    });
  });
});

// ── header rendering ──────────────────────────────────────────────────────────

describe("CycleView — header", () => {
  it("renders cycle label as h2", () => {
    renderCycleView(ACTIVE_CYCLE, []);
    expect(
      screen.getByRole("heading", { name: /Cycle 01/i }),
    ).toBeInTheDocument();
  });

  it("renders window as MM.DD — MM.DD", () => {
    renderCycleView(ACTIVE_CYCLE, []);
    expect(screen.getByText(/05\.26 — 06\.08/)).toBeInTheDocument();
  });

  it("renders UNSCHEDULED window for BACKLOG pseudo-cycle", () => {
    renderCycleView(BACKLOG_PSEUDO, []);
    expect(screen.getByText(/UNSCHEDULED/)).toBeInTheDocument();
  });

  it("renders goal text", () => {
    renderCycleView(ACTIVE_CYCLE, []);
    expect(screen.getByText(/Ship the board shell/)).toBeInTheDocument();
  });

  it("renders cycle state label", () => {
    renderCycleView(ACTIVE_CYCLE, []);
    expect(screen.getByText(/ACTIVE/)).toBeInTheDocument();
  });
});

// ── metrics + burndown ────────────────────────────────────────────────────────

describe("CycleView — metrics and burndown", () => {
  it("renders COMMITTED metric zero-padded", () => {
    renderCycleView(ACTIVE_CYCLE, C01_TASKS); // 3 tasks
    expect(screen.getByText("03")).toBeInTheDocument();
  });

  it("renders BURNDOWN label", () => {
    renderCycleView(ACTIVE_CYCLE, C01_TASKS);
    expect(screen.getByText("BURNDOWN")).toBeInTheDocument();
  });

  it("renders the Spark SVG for burndown", () => {
    renderCycleView(ACTIVE_CYCLE, C01_TASKS);
    // Spark renders an SVG polyline
    const svg = document.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg?.querySelector("polyline")).toBeInTheDocument();
  });

  it("renders HOLD metric in hot color when hold > 0", () => {
    renderCycleView(ACTIVE_CYCLE, [T_HOLD]);
    // Multiple "HOLD" texts may exist (metric label + HoldTag in a row).
    // Find the one that is the metric label (uppercase tracking span) and
    // check its sibling <b>.
    const holdLabels = screen.getAllByText("HOLD");
    // The metric label "HOLD" is wrapped in a div.flex-col alongside a <b>
    const metricLabel = holdLabels.find(
      (el) => el.closest("div")?.querySelector("b") !== null,
    );
    const metricValue = metricLabel?.closest("div")?.querySelector("b");
    // data-hot attribute is used (not a CSS class) to avoid Tailwind purging
    expect(metricValue?.getAttribute("data-hot")).toBe("true");
  });

  it("renders HOLD metric without hot color when hold = 0", () => {
    renderCycleView(ACTIVE_CYCLE, [T_FIELD]);
    const holdLabel = screen.getByText("HOLD"); // only one "HOLD" — no HoldTag
    const metricValue = holdLabel.closest("div")?.querySelector("b");
    expect(metricValue?.getAttribute("data-hot")).toBeNull();
  });
});

// ── progress bar ──────────────────────────────────────────────────────────────

describe("CycleView — progress bar", () => {
  it("renders pct SEALED label", () => {
    renderCycleView(ACTIVE_CYCLE, [T_SEALED, T_FIELD]); // 1/2 = 50%
    expect(screen.getByText(/50% SEALED/)).toBeInTheDocument();
  });

  it("renders 0% SEALED when no tasks", () => {
    renderCycleView(ACTIVE_CYCLE, []);
    expect(screen.getByText(/0% SEALED/)).toBeInTheDocument();
  });

  it("renders checks summary", () => {
    renderCycleView(ACTIVE_CYCLE, [T_SEALED]); // checks: [3,3]
    expect(screen.getByText(/3\/3 CHECKS/)).toBeInTheDocument();
  });
});

// ── lanes — only non-empty, COL_ORDER ─────────────────────────────────────────

describe("CycleView — lanes", () => {
  it("only renders lanes for non-empty columns", () => {
    // C01_TASKS: t1=FIELD, t3=TRIAGE, t5=SEALED → 3 non-empty lanes
    renderCycleView(ACTIVE_CYCLE, C01_TASKS);
    expect(screen.getByTestId("cv-lane-FIELD")).toBeInTheDocument();
    expect(screen.getByTestId("cv-lane-TRIAGE")).toBeInTheDocument();
    expect(screen.getByTestId("cv-lane-SEALED")).toBeInTheDocument();
    expect(screen.queryByTestId("cv-lane-INTAKE")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cv-lane-REVIEW")).not.toBeInTheDocument();
  });

  it("lane header shows zero-padded count", () => {
    renderCycleView(ACTIVE_CYCLE, [T_FIELD]);
    // 1 task in FIELD
    expect(screen.getByTestId("cv-lane-count-FIELD")).toHaveTextContent("01");
  });

  it("lane header shows COL_LABEL text (FIELD→IN-FIELD)", () => {
    renderCycleView(ACTIVE_CYCLE, [T_FIELD]);
    // "IN-FIELD" appears in both the metrics section and the lane header;
    // verify at least one exists (lane is rendered).
    expect(screen.getAllByText("IN-FIELD").length).toBeGreaterThanOrEqual(1);
    // The lane header span specifically
    const laneHd = screen.getByTestId("cv-lane-FIELD");
    expect(laneHd.textContent).toContain("IN-FIELD");
  });

  it("tasks appear in COL_ORDER across lanes", () => {
    renderCycleView(ACTIVE_CYCLE, C01_TASKS);
    const lanes = screen.getAllByTestId(/^cv-lane-[A-Z]+$/);
    const laneIds = lanes.map((el) =>
      el.getAttribute("data-testid")!.replace("cv-lane-", ""),
    );
    // TRIAGE (index 1) before FIELD (index 2) before SEALED (index 4)
    expect(laneIds.indexOf("TRIAGE")).toBeLessThan(laneIds.indexOf("FIELD"));
    expect(laneIds.indexOf("FIELD")).toBeLessThan(laneIds.indexOf("SEALED"));
  });

  it("renders task row with code, title, project, assignee", () => {
    renderCycleView(ACTIVE_CYCLE, [T_FIELD]);
    expect(screen.getByTestId("cv-row-tf1")).toBeInTheDocument();
    expect(screen.getByText("TSK-9003")).toBeInTheDocument();
    expect(screen.getByText("Field task")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("renders HOLD tag inline in title cell for held tasks", () => {
    renderCycleView(ACTIVE_CYCLE, [T_HOLD]);
    const row = screen.getByTestId("cv-row-th1");
    expect(
      row.querySelector("[data-testid='cv-hold-th1']"),
    ).toBeInTheDocument();
  });

  it("renders PriChip for each row", () => {
    renderCycleView(ACTIVE_CYCLE, [T_FIELD]);
    // T_FIELD is P2 — PriChip renders the pri text
    expect(screen.getByTestId("cv-row-tf1").textContent).toContain("P2");
  });

  it("renders d/total checks for tasks with checklist", () => {
    renderCycleView(ACTIVE_CYCLE, [T_HOLD]); // checks: [2,5]
    expect(screen.getByText("2/5")).toBeInTheDocument();
  });

  it("renders — in the checks column when checks is empty", () => {
    renderCycleView(ACTIVE_CYCLE, [T_FIELD]); // checks: []
    // T_FIELD has no assignee (→ "—") and no checks (→ "—"); at least one "—"
    // belongs to the checks cell. Verify via the row's textContent.
    const row = screen.getByTestId("cv-row-tf1");
    expect(row.textContent).toContain("—");
  });
});

// ── row click sets editTaskId ─────────────────────────────────────────────────

describe("CycleView — row click", () => {
  it("clicking a row sets editTaskId", async () => {
    renderCycleView(ACTIVE_CYCLE, [T_FIELD]);
    await userEvent.click(screen.getByTestId("cv-row-tf1"));
    expect(useBoardStore.getState().editTaskId).toBe("tf1");
  });
});

// ── empty state ───────────────────────────────────────────────────────────────

describe("CycleView — empty state", () => {
  it("renders ∅ glyph when no tasks", () => {
    renderCycleView(ACTIVE_CYCLE, []);
    expect(screen.getByText("∅")).toBeInTheDocument();
  });

  it("renders NO TASKS IN {label}", () => {
    renderCycleView(ACTIVE_CYCLE, []);
    expect(screen.getByText(/NO TASKS IN Cycle 01/i)).toBeInTheDocument();
  });

  it("renders COMMIT TASK button", () => {
    renderCycleView(ACTIVE_CYCLE, []);
    expect(
      screen.getByRole("button", { name: /COMMIT TASK/i }),
    ).toBeInTheDocument();
  });

  it("COMMIT TASK button opens taskModal with cycle preset", async () => {
    renderCycleView(ACTIVE_CYCLE, []);
    await userEvent.click(screen.getByRole("button", { name: /COMMIT TASK/i }));
    const modal = useBoardStore.getState().taskModal;
    expect(modal).toMatchObject({ cycle: "C-01" });
  });

  it("COMMIT TASK button on BACKLOG opens taskModal without cycle", async () => {
    renderCycleView(BACKLOG_PSEUDO, []);
    await userEvent.click(screen.getByRole("button", { name: /COMMIT TASK/i }));
    const modal = useBoardStore.getState().taskModal;
    expect(modal).not.toHaveProperty("cycle");
  });

  it("COMMIT TASK includes project when activeProject prop is set", async () => {
    render(<CycleView cycle={ACTIVE_CYCLE} tasks={[]} activeProject="alpha" />);
    await userEvent.click(screen.getByRole("button", { name: /COMMIT TASK/i }));
    expect(useBoardStore.getState().taskModal).toEqual({
      cycle: "C-01",
      project: "alpha",
    });
  });

  it("COMMIT TASK omits project when activeProject prop is absent", async () => {
    render(<CycleView cycle={ACTIVE_CYCLE} tasks={[]} />);
    await userEvent.click(screen.getByRole("button", { name: /COMMIT TASK/i }));
    const modal = useBoardStore.getState().taskModal;
    expect(modal).toEqual({ cycle: "C-01" });
    expect(modal).not.toHaveProperty("project");
  });
});

// ── task filtering (backlog vs named cycle) ───────────────────────────────────

describe("CycleView — task filtering", () => {
  it("named cycle only shows tasks matching that cycle code", () => {
    // All tasks passed in; CycleView filters internally
    renderCycleView(ACTIVE_CYCLE, tasks);
    // t2 and t4 have no cycle — should NOT appear in lanes
    expect(screen.queryByText("Task Alpha 2")).not.toBeInTheDocument();
    expect(screen.queryByText("Task Unfiled")).not.toBeInTheDocument();
    // C-01 tasks should appear
    expect(screen.getByText("Task Alpha 1")).toBeInTheDocument();
  });

  it("BACKLOG pseudo-cycle shows only tasks with no cycle", () => {
    renderCycleView(BACKLOG_PSEUDO, tasks);
    // t2 and t4 have no cycle
    expect(screen.getByText("Task Alpha 2")).toBeInTheDocument();
    expect(screen.getByText("Task Unfiled")).toBeInTheDocument();
    // C-01 tasks should NOT appear
    expect(screen.queryByText("Task Alpha 1")).not.toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TaskingScreen integration — mode "cycle" renders CycleView
// ════════════════════════════════════════════════════════════════════════════

describe("TaskingScreen integration — cycle mode", () => {
  function renderScreen() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <TaskingScreen />
      </QueryClientProvider>,
    );
  }

  it("renders CycleView (not the placeholder) in cycle mode", async () => {
    useBoardStore.setState({ mode: "cycle", cycleSel: "C-01" });
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");
    // CycleView renders the cycle label as h2
    expect(
      screen.getByRole("heading", { name: /Cycle 01/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/COMING SOON/)).not.toBeInTheDocument();
  });

  it("resolves to ACTIVE cycle when cycleSel is empty string", async () => {
    useBoardStore.setState({ mode: "cycle", cycleSel: "" });
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");
    // C-01 is ACTIVE
    expect(
      screen.getByRole("heading", { name: /Cycle 01/i }),
    ).toBeInTheDocument();
  });

  it("resolves to BACKLOG pseudo-cycle when cycleSel is BACKLOG", async () => {
    useBoardStore.setState({ mode: "cycle", cycleSel: "BACKLOG" });
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");
    expect(
      screen.getByRole("heading", { name: /BACKLOG/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/UNSCHEDULED/)).toBeInTheDocument();
  });

  it("op with slug active: COMMIT TASK presets {cycle, project}", async () => {
    // C-02 has no tasks → empty state with COMMIT TASK; "alpha" op has a slug
    useBoardStore.setState({
      mode: "cycle",
      cycleSel: "C-02",
      opFilter: "alpha",
    });
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");

    await userEvent.click(screen.getByRole("button", { name: /COMMIT TASK/i }));
    expect(useBoardStore.getState().taskModal).toEqual({
      cycle: "C-02",
      project: "alpha",
    });
  });

  it("slug-less op active: COMMIT TASK presets {cycle} only — the op CODE is not a project", async () => {
    // opFilter holds OPS-3 (the op code; NO_SLUG_OP has project: null).
    // No task carries the code as a project → empty state in any cycle.
    useBoardStore.setState({
      mode: "cycle",
      cycleSel: "C-02",
      opFilter: "OPS-3",
    });
    stubBoardFetch(BOARD_FIXTURE_WITH_NO_SLUG_OP);
    renderScreen();
    await screen.findByText("TASKING BOARD");

    await userEvent.click(screen.getByRole("button", { name: /COMMIT TASK/i }));
    const modal = useBoardStore.getState().taskModal;
    expect(modal).toEqual({ cycle: "C-02" });
    expect(modal).not.toHaveProperty("project");
  });
});

// ── ScopeRail cycle click still works ────────────────────────────────────────

describe("ScopeRail — cycle selection still passes", () => {
  function renderScreen() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <TaskingScreen />
      </QueryClientProvider>,
    );
  }

  it("clicking a cycle in ScopeRail sets cycleSel and mode to cycle", async () => {
    useBoardStore.setState({ mode: "card", cycleSel: "" });
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");

    // Click C-02 in the rail
    const c02btn = screen.getByText("C-02").closest("button")!;
    await userEvent.click(c02btn);

    expect(useBoardStore.getState().cycleSel).toBe("C-02");
    expect(useBoardStore.getState().mode).toBe("cycle");
  });
});
