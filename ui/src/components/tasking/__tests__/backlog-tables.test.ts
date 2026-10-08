import { describe, expect, it } from "vitest";
import type { BoardCycle, BoardTask } from "#/api/board";
import { splitBacklog } from "../backlog-tables";
import { BOARD_FIXTURE } from "./fixtures";

const ACTIVE: BoardCycle = BOARD_FIXTURE.cycles[0];

function task(id: string, patch: Partial<BoardTask> = {}): BoardTask {
  return {
    blocked_by: [],
    blocks: [],
    blocked: false,
    id,
    code: `TSK-${id}`,
    title: id,
    body_excerpt: null,
    status: "TRIAGE",
    priority: "P2",
    project: null,
    due: null,
    cycle: null,
    tags: [],
    checks: [],
    path: `tasks/${id}.md`,
    updated_at: "2026-10-01T00:00:00Z",
    ...patch,
  };
}

const ids = (tasks: BoardTask[] | null) => tasks?.map((t) => t.id) ?? null;

describe("splitBacklog", () => {
  it("puts the active cycle's tasks in the cycle table, the rest in the backlog", () => {
    const tasks = [
      task("in", { cycle: ACTIVE.code }),
      task("planned", { cycle: "C-02" }),
      task("none"),
    ];
    const split = splitBacklog(tasks, ACTIVE, { showDone: false });
    expect(ids(split.cycle)).toEqual(["in"]);
    expect(ids(split.backlog)).toEqual(["planned", "none"]);
  });

  it("has no cycle table without an active cycle", () => {
    const tasks = [task("a", { cycle: "C-01" }), task("b")];
    const split = splitBacklog(tasks, null, { showDone: false });
    expect(split.cycle).toBeNull();
    expect(ids(split.backlog)).toEqual(["a", "b"]);
  });

  it("keeps an empty cycle table when the active cycle has no tasks", () => {
    const split = splitBacklog([task("b")], ACTIVE, { showDone: false });
    expect(split.cycle).toEqual([]);
  });

  it("hides SEALED tasks from both tables unless showDone", () => {
    const tasks = [
      task("done-in", { cycle: ACTIVE.code, status: "SEALED" }),
      task("open-in", { cycle: ACTIVE.code }),
      task("done-out", { status: "SEALED" }),
    ];
    const hidden = splitBacklog(tasks, ACTIVE, { showDone: false });
    expect(ids(hidden.cycle)).toEqual(["open-in"]);
    expect(ids(hidden.backlog)).toEqual([]);
    const shown = splitBacklog(tasks, ACTIVE, { showDone: true });
    expect(ids(shown.cycle)).toEqual(["open-in", "done-in"]);
    expect(ids(shown.backlog)).toEqual(["done-out"]);
  });

  it("sorts by priority, then status, then due date with no due last", () => {
    const tasks = [
      task("p2-field", { priority: "P2", status: "FIELD" }),
      task("p3", { priority: "P3", status: "INTAKE" }),
      task("p0-field-nodue", { priority: "P0", status: "FIELD" }),
      task("p0-field-late", {
        priority: "P0",
        status: "FIELD",
        due: "2026-12-01",
      }),
      task("p0-field-early", {
        priority: "P0",
        status: "FIELD",
        due: "2026-11-01",
      }),
      task("p0-intake", { priority: "P0", status: "INTAKE" }),
      task("p1-review", { priority: "P1", status: "REVIEW" }),
      task("p2-intake", { priority: "P2", status: "INTAKE" }),
    ];
    const { backlog } = splitBacklog(tasks, null, { showDone: false });
    expect(ids(backlog)).toEqual([
      "p0-intake",
      "p0-field-early",
      "p0-field-late",
      "p0-field-nodue",
      "p1-review",
      "p2-intake",
      "p2-field",
      "p3",
    ]);
  });

  it("does not reorder its input", () => {
    const tasks = [
      task("b", { priority: "P3" }),
      task("a", { priority: "P0" }),
    ];
    splitBacklog(tasks, null, { showDone: false });
    expect(ids(tasks)).toEqual(["b", "a"]);
  });
});
