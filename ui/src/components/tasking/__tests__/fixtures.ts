import { vi } from "vitest";
import type { BoardResponse } from "#/api/board";

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
    },
  ],
};

/** Stub fetch to resolve with BOARD_FIXTURE */
export function stubBoardFetch() {
  const stub = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(BOARD_FIXTURE),
    } as Response),
  );
  vi.stubGlobal("fetch", stub);
  return stub;
}
