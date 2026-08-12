import { vi } from "vitest";
import type { BoardResponse } from "#/api/board";
import type { ColLabelFn } from "../board-constants";

/** Minimal BoardResponse fixture reused across tasking view tests. */
export const BOARD_FIXTURE: BoardResponse = {
  columns: [
    { id: "INTAKE", label: "INTAKE", sub: "", wip: 0 },
    { id: "TRIAGE", label: "TRIAGE", sub: "", wip: 0 },
    { id: "FIELD", label: "IN-FIELD", sub: "", wip: 0 },
    { id: "REVIEW", label: "REVIEW", sub: "", wip: 0 },
    { id: "SEALED", label: "SEALED", sub: "", wip: 0 },
  ],
  operations: [
    {
      id: "op-aaa-111",
      code: "OPS-1",
      name: "Operation Alpha",
      health: "GREEN",
      path: "tasks/ops-1.md",
      project: "alpha",
      lead: "Kit",
      target: "2026-Q3",
      dossier: "tasks/ops-1",
      note: "On track",
    },
    {
      id: "op-bbb-222",
      code: "OPS-2",
      name: "Operation Beta",
      health: "AMBER",
      path: "tasks/ops-2.md",
      project: "beta",
      lead: "Alex",
      target: "2026-Q4",
      dossier: "tasks/ops-2",
      note: "Some delays",
    },
  ],
  cycles: [
    {
      id: "cyc-111",
      code: "C-01",
      label: "Cycle 01",
      state: "ACTIVE",
      path: "tasks/c-01.md",
      start: "2026-05-26",
      end: "2026-06-08",
      goal: "Ship the board shell.",
    },
    {
      id: "cyc-222",
      code: "C-02",
      label: "Cycle 02",
      state: "PLANNED",
      path: "tasks/c-02.md",
      start: "2026-06-09",
      end: "2026-06-22",
      goal: null,
    },
  ],
  tasks: [
    {
      id: "t1",
      code: "TSK-0001",
      title: "Task Alpha 1",
      status: "FIELD",
      priority: "P1",
      project: "alpha",
      cycle: "C-01",
      tags: [],
      checks: [],
      path: "tasks/t1.md",
      updated_at: "2026-06-01T00:00:00Z",
      body_excerpt: "A concise projected task body.",
    },
    {
      id: "t2",
      code: "TSK-0002",
      title: "Task Alpha 2",
      status: "INTAKE",
      priority: "P2",
      project: "alpha",
      cycle: null,
      hold: "blocker",
      tags: [],
      checks: [],
      path: "tasks/t2.md",
      updated_at: "2026-06-02T00:00:00Z",
      body_excerpt: "",
    },
    {
      id: "t3",
      code: "TSK-0003",
      title: "Task Beta 1",
      status: "TRIAGE",
      priority: "P2",
      project: "beta",
      cycle: "C-01",
      tags: [],
      checks: [],
      path: "tasks/t3.md",
      updated_at: "2026-06-03T00:00:00Z",
      body_excerpt: null,
    },
    {
      id: "t4",
      code: "TSK-0004",
      title: "Task Unfiled",
      status: "INTAKE",
      priority: "P3",
      project: null,
      cycle: null,
      tags: [],
      checks: [],
      path: "tasks/t4.md",
      updated_at: "2026-06-04T00:00:00Z",
      body_excerpt: null,
    },
    {
      id: "t5",
      code: "TSK-0005",
      title: "Task Sealed",
      status: "SEALED",
      priority: "P2",
      project: "alpha",
      cycle: "C-01",
      tags: [],
      checks: [],
      path: "tasks/t5.md",
      updated_at: "2026-06-05T00:00:00Z",
      body_excerpt: null,
    },
  ],
};

/**
 * A board:true PROJECT page with no project: frontmatter — its canonical
 * opFilter key falls back to the op code (see opKey in board-constants).
 */
export const NO_SLUG_OP: BoardResponse["operations"][number] = {
  id: "op-ccc-333",
  code: "OPS-3",
  name: "Operation Gamma",
  health: "GREEN",
  path: "tasks/ops-3.md",
  project: null,
  lead: "Riva",
  target: "2026-Q4",
  dossier: null,
  note: null,
};

export const BOARD_FIXTURE_WITH_NO_SLUG_OP: BoardResponse = {
  ...BOARD_FIXTURE,
  operations: [...BOARD_FIXTURE.operations, NO_SLUG_OP],
};

/**
 * A CLOSED cycle — used to test the sealed-in-closed-cycle exclusion
 * (Decision 8 / visibleInKanban).
 */
export const CLOSED_CYCLE: BoardResponse["cycles"][number] = {
  id: "cyc-closed-000",
  code: "C-00",
  label: "Cycle 00",
  state: "CLOSED",
  path: "tasks/c-00.md",
  start: "2026-05-12",
  end: "2026-05-25",
  goal: "Completed sprint.",
};

/**
 * A task that is SEALED and whose cycle is CLOSED — should be excluded
 * from the kanban SEALED column (but stay in backlog/other views).
 */
export const SEALED_IN_CLOSED_CYCLE_TASK: BoardResponse["tasks"][number] = {
  id: "t-hist",
  code: "TSK-0099",
  title: "Historical Sealed Task",
  status: "SEALED",
  priority: "P3",
  project: "alpha",
  cycle: "C-00",
  tags: [],
  checks: [],
  path: "tasks/t-hist.md",
  updated_at: "2026-05-25T00:00:00Z",
  body_excerpt: null,
};

/** BOARD_FIXTURE augmented with a CLOSED cycle + a sealed-in-closed-cycle task */
export const BOARD_FIXTURE_WITH_CLOSED_CYCLE: BoardResponse = {
  ...BOARD_FIXTURE,
  cycles: [...BOARD_FIXTURE.cycles, CLOSED_CYCLE],
  tasks: [...BOARD_FIXTURE.tasks, SEALED_IN_CLOSED_CYCLE_TASK],
};

/**
 * colLabel resolver built from BOARD_FIXTURE.columns — mirrors what
 * TaskingScreen derives from live server data (see board-constants
 * ColLabelFn), for tests that render a view component directly without
 * going through TaskingScreen.
 */
export const FIXTURE_COL_LABEL: ColLabelFn = (id) =>
  BOARD_FIXTURE.columns.find((c) => c.id === id)?.label ?? id;

/** Stub fetch to resolve with the given board (defaults to BOARD_FIXTURE) */
export function stubBoardFetch(board: BoardResponse = BOARD_FIXTURE) {
  const stub = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(board),
    } as Response),
  );
  vi.stubGlobal("fetch", stub);
  return stub;
}
