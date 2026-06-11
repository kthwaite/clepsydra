import { describe, expect, it } from "vitest";
import type { BoardResponse, BoardTask } from "#/api/board";
import { applyTaskPatch } from "#/api/board";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "task-1",
    code: "T-1",
    title: "Test task",
    status: "BACKLOG",
    priority: "MEDIUM",
    path: "tasks/T-1.md",
    tags: [],
    checks: [],
    updated_at: "2026-06-11T00:00:00Z",
    cycle: null,
    assignee: null,
    estimate: null,
    due: null,
    hold: null,
    link: null,
    project: null,
    start: null,
    ...overrides,
  };
}

function makeBoard(tasks: BoardTask[]): BoardResponse {
  return {
    columns: [],
    cycles: [],
    operations: [],
    tasks,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyTaskPatch", () => {
  it("moves status when status is provided", () => {
    const board = makeBoard([makeTask({ status: "BACKLOG" })]);
    const result = applyTaskPatch(board, "task-1", { status: "DOING" });
    expect(result.tasks[0].status).toBe("DOING");
  });

  it("leaves status unchanged when status is absent from patch", () => {
    const board = makeBoard([makeTask({ status: "BACKLOG" })]);
    const result = applyTaskPatch(board, "task-1", { priority: "HIGH" });
    expect(result.tasks[0].status).toBe("BACKLOG");
  });

  it("clears hold to null when hold is explicitly null", () => {
    const board = makeBoard([makeTask({ hold: "blocked by design" })]);
    const result = applyTaskPatch(board, "task-1", { hold: null });
    expect(result.tasks[0].hold).toBeNull();
  });

  it("leaves cycle unchanged when cycle is absent from patch", () => {
    const board = makeBoard([makeTask({ cycle: "S-10" })]);
    const result = applyTaskPatch(board, "task-1", { status: "DOING" });
    expect(result.tasks[0].cycle).toBe("S-10");
  });

  it("sets cycle when cycle is a string value", () => {
    const board = makeBoard([makeTask({ cycle: null })]);
    const result = applyTaskPatch(board, "task-1", { cycle: "S-12" });
    expect(result.tasks[0].cycle).toBe("S-12");
  });

  it("clears cycle when cycle is null", () => {
    const board = makeBoard([makeTask({ cycle: "S-10" })]);
    const result = applyTaskPatch(board, "task-1", { cycle: null });
    expect(result.tasks[0].cycle).toBeNull();
  });

  it("replaces tags when tags array is provided", () => {
    const board = makeBoard([makeTask({ tags: ["feat", "urgent"] })]);
    const result = applyTaskPatch(board, "task-1", { tags: ["chore"] });
    expect(result.tasks[0].tags).toEqual(["chore"]);
  });

  it("leaves tags unchanged when tags is absent from patch", () => {
    const board = makeBoard([makeTask({ tags: ["feat"] })]);
    const result = applyTaskPatch(board, "task-1", { status: "DONE" });
    expect(result.tasks[0].tags).toEqual(["feat"]);
  });

  it("returns board unchanged when id is not found", () => {
    const board = makeBoard([makeTask()]);
    const result = applyTaskPatch(board, "no-such-id", { status: "DONE" });
    expect(result).toBe(board); // same reference
  });

  it("does not mutate the original board", () => {
    const task = makeTask({ status: "BACKLOG" });
    const board = makeBoard([task]);
    applyTaskPatch(board, "task-1", { status: "DOING" });
    expect(board.tasks[0].status).toBe("BACKLOG");
    expect(task.status).toBe("BACKLOG");
  });

  it("leaves other tasks untouched when one task is patched", () => {
    const t1 = makeTask({ id: "task-1", status: "BACKLOG" });
    const t2 = makeTask({ id: "task-2", status: "DOING" });
    const board = makeBoard([t1, t2]);
    const result = applyTaskPatch(board, "task-1", { status: "DONE" });
    expect(result.tasks[0].status).toBe("DONE");
    expect(result.tasks[1].status).toBe("DOING");
    expect(result.tasks[1]).toBe(t2); // same reference for untouched task
  });
});
