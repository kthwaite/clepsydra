import { describe, expect, it } from "vitest";
import type { CalendarTask, CalendarTodo } from "#/api/calendar";
import { bucketTodos, isTodoOpen } from "#/lib/calendar/todos";

const todo = (over: Partial<CalendarTodo> = {}): CalendarTodo => ({
  kind: "todo",
  content: "Buy milk",
  status: "todo",
  due: "2026-10-02",
  page_path: "notes/a.md",
  span_start: 0,
  ...over,
});

const task = (over: Partial<CalendarTask> = {}): CalendarTask => ({
  kind: "task",
  id: "01900000-0000-7000-8000-000000000001",
  code: "TSK-brave-finch-7q3zd",
  title: "Ship it",
  status: "FIELD",
  priority: "P2",
  due: "2026-10-02",
  path: "tasks/TSK-brave-finch-7q3zd.md",
  ...over,
});

describe("isTodoOpen", () => {
  it("treats todo and doing checkboxes as open", () => {
    expect(isTodoOpen(todo({ status: "todo" }))).toBe(true);
    expect(isTodoOpen(todo({ status: "doing" }))).toBe(true);
    expect(isTodoOpen(todo({ status: "done" }))).toBe(false);
    expect(isTodoOpen(todo({ status: "cancelled" }))).toBe(false);
  });

  it("treats every TASK status but SEALED as open", () => {
    for (const status of ["INTAKE", "TRIAGE", "FIELD", "REVIEW"] as const) {
      expect(isTodoOpen(task({ status }))).toBe(true);
    }
    expect(isTodoOpen(task({ status: "SEALED" }))).toBe(false);
  });
});

describe("bucketTodos", () => {
  const range = { first: "2026-09-28", last: "2026-11-08" };

  it("keys items by their due date, keeping input order within a day", () => {
    const a = todo({ span_start: 1 });
    const b = task();
    const c = todo({ due: "2026-10-05", span_start: 2 });
    const out = bucketTodos([a, b, c], range);
    expect(out.get("2026-10-02")).toEqual([a, b]);
    expect(out.get("2026-10-05")).toEqual([c]);
    expect(out.size).toBe(2);
  });

  it("keeps both range edges and trims days outside them", () => {
    const first = todo({ due: "2026-09-28" });
    const last = todo({ due: "2026-11-08" });
    const before = todo({ due: "2026-09-27" });
    const after = task({ due: "2026-11-09" });
    const out = bucketTodos([before, first, last, after], range);
    expect([...out.keys()]).toEqual(["2026-09-28", "2026-11-08"]);
  });
});
