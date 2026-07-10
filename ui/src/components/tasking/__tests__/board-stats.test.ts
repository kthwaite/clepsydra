import { describe, expect, it } from "vitest";
import type { BoardTask } from "#/api/board";
import { checklistProgress, cycleStats, sealStats } from "../board-stats";

const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  id: "t-1",
  code: "T-001",
  title: "Test",
  status: "FIELD",
  priority: "P2",
  project: null,
  cycle: "C-01",
  assignee: null,
  estimate: null,
  due: null,
  tags: [],
  checks: [],
  hold: null,
  link: null,
  path: "tasks/t-1.md",
  updated_at: "2026-06-10T00:00:00Z",
  ...patch,
});

describe("checklistProgress", () => {
  it("treats a short tuple as zero progress", () => {
    expect(checklistProgress([3])).toEqual({
      done: 0,
      total: 0,
      percent: 0,
      isComplete: false,
    });
  });

  it("preserves current percentage and exact-completion semantics", () => {
    expect(checklistProgress([1, 4])).toEqual({
      done: 1,
      total: 4,
      percent: 25,
      isComplete: false,
    });
    expect(checklistProgress([4, 4]).isComplete).toBe(true);
    expect(checklistProgress([5, 4]).isComplete).toBe(false);
  });
});

describe("cycleStats", () => {
  it("aggregates statuses, holds, and checklist tuples", () => {
    expect(
      cycleStats([
        task({ checks: [2, 5], hold: "blocked" }),
        task({ id: "t-2", status: "SEALED", checks: [3, 3] }),
      ]),
    ).toEqual({
      committed: 2,
      sealed: 1,
      field: 1,
      hold: 1,
      checkDone: 5,
      checkTot: 8,
      pct: 50,
    });
  });
});

describe("sealStats", () => {
  it("filters by cycle and derives carryover", () => {
    expect(
      sealStats(
        [
          task(),
          task({ id: "t-2", status: "SEALED" }),
          task({ id: "t-3", cycle: "C-02" }),
        ],
        "C-01",
      ),
    ).toMatchObject({ committed: 2, sealed: 1, carryover: 1, pct: 50 });
  });
});
