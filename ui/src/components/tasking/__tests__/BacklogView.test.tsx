/**
 * BacklogView tests.
 *
 * groupBacklog — pure unit tests for grouping/sorting logic.
 * BacklogView  — render/interaction tests.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { BoardTask } from "#/api/board";
import { useBoardStore } from "#/store/board";
import { BacklogView, groupBacklog } from "../BacklogView";
import { BOARD_FIXTURE } from "./fixtures";

// ── shared fixture slices ─────────────────────────────────────────────────────

const { tasks } = BOARD_FIXTURE;

// Extra tasks used in BacklogView-specific fixtures

/** P0 task with a due date */
const T_P0_DUE: BoardTask = {
  id: "bk-p0-due",
  code: "TSK-1000",
  title: "Critical with due",
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
  id: "bk-p0-nodue",
  code: "TSK-1001",
  title: "Critical no due",
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
  id: "bk-p1-hold",
  code: "TSK-1002",
  title: "High priority on hold",
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
  id: "bk-p2-checks",
  code: "TSK-1003",
  title: "Normal with checklist",
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
  id: "bk-p2-done",
  code: "TSK-1004",
  title: "Normal fully done",
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
  id: "bk-p2-intake",
  code: "TSK-1005",
  title: "Normal in intake",
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
// groupBacklog — pure unit tests
// ══════════════════════════════════════════════════════════════════════════════

describe("groupBacklog", () => {
  it("groups tasks by priority in P0→P3 order", () => {
    const groups = groupBacklog([T_P0_DUE, T_P1_HOLD, T_P2_CHECKS]);
    expect(groups.map((g) => g.pri)).toEqual(["P0", "P1", "P2"]);
  });

  it("drops empty priority groups", () => {
    // Only P1 and P3 represented
    const t_p3: BoardTask = { ...tasks[3], priority: "P3" };
    const groups = groupBacklog([T_P1_HOLD, t_p3]);
    expect(groups.map((g) => g.pri)).toEqual(["P1", "P3"]);
  });

  it("returns empty array when tasks is empty", () => {
    expect(groupBacklog([])).toEqual([]);
  });

  it("within group: sorts by COL_ORDER index (INTAKE before FIELD)", () => {
    // T_P2_INTAKE is INTAKE (index 0), T_P2_CHECKS is FIELD (index 2)
    const groups = groupBacklog([T_P2_CHECKS, T_P2_INTAKE]);
    const p2 = groups.find((g) => g.pri === "P2")!;
    expect(p2.items[0].id).toBe("bk-p2-intake");
    expect(p2.items[1].id).toBe("bk-p2-checks");
  });

  it("within group (same col): tasks with no due sort after tasks with due", () => {
    // T_P0_DUE and T_P0_NODUE are both in different columns, but test same-col too
    // Make both FIELD to isolate due-sort
    const aDue: BoardTask = {
      ...T_P0_DUE,
      id: "a",
      status: "FIELD",
      due: "2026-09-01",
    };
    const aNodue: BoardTask = {
      ...T_P0_NODUE,
      id: "b",
      status: "FIELD",
      due: null,
    };
    const groups = groupBacklog([aNodue, aDue]);
    const p0 = groups.find((g) => g.pri === "P0")!;
    expect(p0.items[0].id).toBe("a"); // due → first
    expect(p0.items[1].id).toBe("b"); // no-due → last
  });

  it("within group (same col): tasks with earlier due sort before later due", () => {
    const early: BoardTask = {
      ...T_P2_CHECKS,
      id: "early",
      status: "FIELD",
      due: "2026-07-01",
    };
    const late: BoardTask = {
      ...T_P2_CHECKS,
      id: "late",
      status: "FIELD",
      due: "2026-09-01",
    };
    const groups = groupBacklog([late, early]);
    const p2 = groups.find((g) => g.pri === "P2")!;
    expect(p2.items[0].id).toBe("early");
    expect(p2.items[1].id).toBe("late");
  });

  it("primary sort is COL_ORDER; due is tiebreaker within same col", () => {
    // col INTAKE (index 0) beats FIELD (index 2) regardless of due date
    const intake: BoardTask = {
      ...T_P2_INTAKE,
      id: "intake-nodue",
      due: null,
    };
    const field: BoardTask = {
      ...T_P2_CHECKS,
      id: "field-due",
      due: "2026-01-01",
    };
    const groups = groupBacklog([field, intake]);
    const p2 = groups.find((g) => g.pri === "P2")!;
    expect(p2.items[0].id).toBe("intake-nodue"); // INTAKE wins regardless
    expect(p2.items[1].id).toBe("field-due");
  });

  it("item count matches input tasks for that priority", () => {
    const groups = groupBacklog([T_P0_DUE, T_P0_NODUE, T_P1_HOLD]);
    const p0 = groups.find((g) => g.pri === "P0")!;
    expect(p0.items).toHaveLength(2);
    const p1 = groups.find((g) => g.pri === "P1")!;
    expect(p1.items).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// BacklogView — render tests
// ══════════════════════════════════════════════════════════════════════════════

beforeEach(() => {
  useBoardStore.setState({
    mode: "backlog",
    opFilter: "ALL",
    cycleSel: "",
    railOpen: true,
    editTaskId: null,
    taskModal: null,
    cycleModal: null,
  });
});

describe("BacklogView — header columns", () => {
  it("renders all 8 header columns", () => {
    render(<BacklogView tasks={[]} />);
    for (const label of [
      "FILE-ID",
      "TASKING",
      "OP",
      "DISPOSITION",
      "OPR",
      "EST",
      "DUE",
      "CHK",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe("BacklogView — grouping", () => {
  it("renders a group header for each non-empty priority", () => {
    render(<BacklogView tasks={[T_P0_DUE, T_P1_HOLD]} />);
    expect(screen.getByText("P0")).toBeInTheDocument();
    expect(screen.getByText("P1")).toBeInTheDocument();
  });

  it("does not render a group header for empty priorities", () => {
    // Only P0 and P1 tasks; P2 and P3 should not appear as group headers
    render(<BacklogView tasks={[T_P0_DUE, T_P1_HOLD]} />);
    // P2 and P3 chips would each appear as a priority group — verify absent
    // by checking group headers specifically (they have bk-grp-pri role)
    const allPriTexts = screen
      .getAllByText(/^P[0-3]$/)
      .map((el) => el.textContent);
    expect(allPriTexts).not.toContain("P2");
    expect(allPriTexts).not.toContain("P3");
  });

  it("renders CRITICAL / HIGH / NORMAL / LOW labels for visible groups", () => {
    render(
      <BacklogView tasks={[T_P0_DUE, T_P1_HOLD, T_P2_CHECKS, tasks[3]]} />,
    );
    expect(screen.getByText("CRITICAL")).toBeInTheDocument();
    expect(screen.getByText("HIGH")).toBeInTheDocument();
    expect(screen.getByText("NORMAL")).toBeInTheDocument();
    expect(screen.getByText("LOW")).toBeInTheDocument();
  });

  it("zero-pads group count to 2 digits (01 ITEMS, 10 ITEMS etc.)", () => {
    render(<BacklogView tasks={[T_P0_DUE]} />);
    expect(screen.getByText("01 ITEMS")).toBeInTheDocument();
  });

  it("zero-pads two-digit group count correctly", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      ...T_P0_DUE,
      id: `p0-${i}`,
      code: `TSK-20${String(i).padStart(2, "0")}`,
    }));
    render(<BacklogView tasks={ten} />);
    expect(screen.getByText("10 ITEMS")).toBeInTheDocument();
  });

  it("first group header has no top border; subsequent group headers do", () => {
    render(<BacklogView tasks={[T_P0_DUE, T_P1_HOLD, T_P2_CHECKS]} />);
    // jsdom expands the border-top shorthand — assert on borderTopStyle
    expect(screen.getByTestId("bk-grp-hd-P0")).toHaveStyle({
      borderTopStyle: "none",
    });
    expect(screen.getByTestId("bk-grp-hd-P1")).toHaveStyle({
      borderTopStyle: "solid",
      borderTopWidth: "1px",
    });
    expect(screen.getByTestId("bk-grp-hd-P2")).toHaveStyle({
      borderTopStyle: "solid",
      borderTopWidth: "1px",
    });
  });
});

describe("BacklogView — row rendering", () => {
  it("renders the task code as FILE-ID", () => {
    render(<BacklogView tasks={[T_P0_DUE]} />);
    expect(screen.getByText("TSK-1000")).toBeInTheDocument();
  });

  it("renders the task title", () => {
    render(<BacklogView tasks={[T_P0_DUE]} />);
    expect(screen.getByText("Critical with due")).toBeInTheDocument();
  });

  it("renders the project in the OP column", () => {
    render(<BacklogView tasks={[T_P0_DUE]} />);
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("renders HOLD tag inline in the title cell when task has hold", () => {
    render(<BacklogView tasks={[T_P1_HOLD]} />);
    // The HOLD tag should be in the same title cell as the task title
    const holdTag = screen.getByTestId("bk-hold-tag-bk-p1-hold");
    expect(holdTag).toBeInTheDocument();
    expect(holdTag).toHaveTextContent("HOLD");
    // Title text also present
    expect(screen.getByText("High priority on hold")).toBeInTheDocument();
  });

  it("does not render HOLD tag when task has no hold", () => {
    render(<BacklogView tasks={[T_P0_DUE]} />);
    expect(
      screen.queryByTestId("bk-hold-tag-bk-p0-due"),
    ).not.toBeInTheDocument();
  });

  it("renders the due date when set", () => {
    render(<BacklogView tasks={[T_P0_DUE]} />);
    expect(screen.getByText("2026-07-01")).toBeInTheDocument();
  });

  it("renders em-dash when due is not set", () => {
    render(<BacklogView tasks={[T_P0_NODUE]} />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders state pip + column label in the DISPOSITION cell", () => {
    // T_P0_DUE is FIELD → label "IN-FIELD"
    render(<BacklogView tasks={[T_P0_DUE]} />);
    expect(screen.getByText("IN-FIELD")).toBeInTheDocument();
  });
});

describe("BacklogView — checklist dots", () => {
  it("renders total number of dots equal to checklist total", () => {
    render(<BacklogView tasks={[T_P2_CHECKS]} />);
    const row = screen.getByTestId("bk-row-bk-p2-checks");
    const dots = row.querySelectorAll("[data-testid^='bk-dot-']");
    expect(dots).toHaveLength(5); // total=5
  });

  it("renders done count of dots with 'on' data attribute", () => {
    render(<BacklogView tasks={[T_P2_CHECKS]} />);
    const row = screen.getByTestId("bk-row-bk-p2-checks");
    const onDots = row.querySelectorAll(
      "[data-testid^='bk-dot-'][data-done='true']",
    );
    expect(onDots).toHaveLength(2); // done=2
  });

  it("all dots are done when checks=[n,n]", () => {
    render(<BacklogView tasks={[T_P2_DONE]} />);
    const row = screen.getByTestId("bk-row-bk-p2-done");
    const allDots = row.querySelectorAll("[data-testid^='bk-dot-']");
    const onDots = row.querySelectorAll(
      "[data-testid^='bk-dot-'][data-done='true']",
    );
    expect(allDots).toHaveLength(3);
    expect(onDots).toHaveLength(3);
  });

  it("renders no dots when checks=[]", () => {
    render(<BacklogView tasks={[T_P0_DUE]} />);
    const row = screen.getByTestId("bk-row-bk-p0-due");
    const dots = row.querySelectorAll("[data-testid^='bk-dot-']");
    expect(dots).toHaveLength(0);
  });
});

describe("BacklogView — row click sets editTaskId", () => {
  it("clicking a row calls setEditTaskId with the task id", async () => {
    render(<BacklogView tasks={[T_P0_DUE]} />);
    const row = screen.getByTestId("bk-row-bk-p0-due");
    await userEvent.click(row);
    expect(useBoardStore.getState().editTaskId).toBe("bk-p0-due");
  });

  it("clicking different rows sets the correct id each time", async () => {
    render(<BacklogView tasks={[T_P0_DUE, T_P1_HOLD]} />);
    await userEvent.click(screen.getByTestId("bk-row-bk-p1-hold"));
    expect(useBoardStore.getState().editTaskId).toBe("bk-p1-hold");
  });
});

describe("BacklogView — within-group sort order in DOM", () => {
  it("renders rows in COL_ORDER then due order within each group", () => {
    // T_P2_INTAKE is INTAKE (index 0), T_P2_CHECKS is FIELD (index 2) with due
    render(<BacklogView tasks={[T_P2_CHECKS, T_P2_INTAKE]} />);
    const rows = screen.getAllByTestId(/^bk-row-/);
    const ids = rows.map((r) => r.dataset.testid?.replace("bk-row-", ""));
    const intakeIdx = ids.indexOf("bk-p2-intake");
    const checksIdx = ids.indexOf("bk-p2-checks");
    expect(intakeIdx).toBeLessThan(checksIdx);
  });

  it("within same col, no-due rows appear after due rows", () => {
    // Both P2 + FIELD: T_P2_CHECKS has due, T_P2_DONE has earlier due
    const noDue: BoardTask = { ...T_P2_CHECKS, id: "bk-nodue-late", due: null };
    const withDue: BoardTask = {
      ...T_P2_CHECKS,
      id: "bk-withdue-early",
      due: "2026-06-01",
    };
    render(<BacklogView tasks={[noDue, withDue]} />);
    const rows = screen.getAllByTestId(/^bk-row-/);
    const ids = rows.map((r) => r.dataset.testid?.replace("bk-row-", ""));
    expect(ids.indexOf("bk-withdue-early")).toBeLessThan(
      ids.indexOf("bk-nodue-late"),
    );
  });
});

describe("BacklogView — empty state", () => {
  it("renders only the header when no tasks are provided", () => {
    render(<BacklogView tasks={[]} />);
    // Header should be present
    expect(screen.getByText("FILE-ID")).toBeInTheDocument();
    // No group headers
    expect(screen.queryByText("CRITICAL")).not.toBeInTheDocument();
  });
});
