import { describe, expect, it } from "vitest";
import type { BoardTask } from "#/api/board";
import {
  cardBlockers,
  indexByCode,
  openBlockers,
  startWarningBlockers,
} from "../blockers";

const task = (patch: Partial<BoardTask> = {}): BoardTask => ({
  blocked_by: [],
  blocks: [],
  blocked: false,
  id: "t-1",
  code: "TSK-1",
  title: "Test",
  body_excerpt: null,
  status: "TRIAGE",
  priority: "P2",
  project: null,
  cycle: null,
  tags: [],
  checks: [],
  path: "tasks/t-1.md",
  updated_at: "2026-10-04T00:00:00Z",
  ...patch,
});

const OPEN = task({ id: "b-open", code: "TSK-OPEN", status: "REVIEW" });
const DONE = task({ id: "b-done", code: "TSK-DONE", status: "SEALED" });
const WAITER = task({
  id: "w",
  code: "TSK-W",
  blocked_by: ["TSK-OPEN", "TSK-DONE", "TSK-GONE"],
});
const BOARD = [OPEN, DONE, WAITER];

describe("openBlockers", () => {
  it("lists blockers on the board that are not Done", () => {
    expect(openBlockers(WAITER, BOARD)).toEqual([OPEN]);
  });

  it("ignores dangling codes and sealed blockers", () => {
    const t = task({ blocked_by: ["TSK-DONE", "TSK-GONE"] });
    expect(openBlockers(t, BOARD)).toEqual([]);
  });
});

describe("startWarningBlockers", () => {
  it("returns open blockers when moving to In Progress", () => {
    expect(startWarningBlockers(WAITER, "FIELD", BOARD)).toEqual([OPEN]);
  });

  it("returns nothing for any other target status", () => {
    for (const status of ["INTAKE", "TRIAGE", "REVIEW", "SEALED"]) {
      expect(startWarningBlockers(WAITER, status, BOARD)).toEqual([]);
    }
  });

  it("returns nothing when the task is already In Progress", () => {
    const started = { ...WAITER, status: "FIELD" };
    expect(startWarningBlockers(started, "FIELD", BOARD)).toEqual([]);
  });

  it("returns nothing when every blocker is Done or dangling", () => {
    const t = task({ blocked_by: ["TSK-DONE", "TSK-GONE"] });
    expect(startWarningBlockers(t, "FIELD", BOARD)).toEqual([]);
  });
});

describe("cardBlockers", () => {
  it("keeps open and dangling blockers in stored order, drops sealed ones", () => {
    expect(cardBlockers(WAITER, indexByCode(BOARD))).toEqual([
      { code: "TSK-OPEN", task: OPEN },
      { code: "TSK-GONE", task: null },
    ]);
  });
});
