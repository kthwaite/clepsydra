import { describe, expect, it } from "vitest";
import type { BoardTask } from "#/api/board";
import {
  blankToNull,
  diffToPatch,
  fromTask,
  newTaskDraft,
  parseTags,
  toCreatePayload,
} from "../taskDraft";

const TASK: BoardTask = {
  id: "t1",
  code: "TSK-1",
  title: "Wire the board",
  path: "tasks/tsk-1.md",
  status: "TRIAGE",
  priority: "P1",
  tags: ["ui", "board"],
  assignee: "Kit",
  estimate: null,
  start: null,
  due: "2026-10-09",
  hold: null,
  link: "[[Spec]]",
  blocked: false,
  blocked_by: [],
  blocks: [],
  body_excerpt: null,
  checks: [],
  updated_at: "2026-10-01T00:00:00Z",
} as BoardTask;

describe("blankToNull", () => {
  it("trims, and maps blank to null", () => {
    expect(blankToNull("  Kit ")).toBe("Kit");
    expect(blankToNull("   ")).toBeNull();
    expect(blankToNull("")).toBeNull();
  });
});

describe("parseTags", () => {
  it("splits on commas, trims, and drops empties", () => {
    expect(parseTags(" ui, board ,, ")).toEqual(["ui", "board"]);
    expect(parseTags("")).toEqual([]);
  });
});

describe("fromTask", () => {
  it("holds every text field as a string; tags comma-joined", () => {
    expect(fromTask(TASK)).toEqual({
      title: "Wire the board",
      assignee: "Kit",
      estimate: "",
      start: "",
      due: "2026-10-09",
      hold: "",
      link: "[[Spec]]",
      tags: "ui, board",
    });
  });
});

describe("diffToPatch", () => {
  it("omits unchanged fields", () => {
    expect(diffToPatch(TASK, fromTask(TASK))).toEqual({});
  });

  it("omits fields absent from the draft", () => {
    expect(diffToPatch(TASK, { assignee: "Alex" })).toEqual({
      assignee: "Alex",
    });
  });

  it("sets a changed text field, trimmed", () => {
    expect(diffToPatch(TASK, { estimate: " 3d " })).toEqual({
      estimate: "3d",
    });
  });

  it("clears an emptied clearable field with null", () => {
    expect(diffToPatch(TASK, { assignee: " ", due: "", link: "" })).toEqual({
      assignee: null,
      due: null,
      link: null,
    });
  });

  it("treats whitespace-only edits of an unset field as unchanged", () => {
    expect(diffToPatch(TASK, { estimate: "  ", start: "" })).toEqual({});
  });

  it("never clears the title: a blank title is omitted", () => {
    expect(diffToPatch(TASK, { title: "  " })).toEqual({});
    expect(diffToPatch(TASK, { title: " Wire the board " })).toEqual({});
    expect(diffToPatch(TASK, { title: "Wire it " })).toEqual({
      title: "Wire it",
    });
  });

  it("replaces the whole tag list when the parsed tags differ", () => {
    expect(diffToPatch(TASK, { tags: "ui,board" })).toEqual({});
    expect(diffToPatch(TASK, { tags: "ui" })).toEqual({ tags: ["ui"] });
    expect(diffToPatch(TASK, { tags: "" })).toEqual({ tags: [] });
  });

  it("edits a hold reason only while held, never clearing the hold", () => {
    expect(diffToPatch(TASK, { hold: "waiting" })).toEqual({});
    const held = { ...TASK, hold: "BLOCKED" };
    expect(diffToPatch(held, { hold: "waiting " })).toEqual({
      hold: "waiting",
    });
    expect(diffToPatch(held, { hold: "" })).toEqual({});
    expect(diffToPatch(held, { hold: "BLOCKED" })).toEqual({});
  });
});

describe("newTaskDraft", () => {
  it("starts blank with the server's default status and priority", () => {
    expect(newTaskDraft()).toEqual({
      title: "",
      body: "",
      project: "",
      cycle: "BACKLOG",
      status: "INTAKE",
      priority: "P2",
      taskType: null,
      assignee: "",
      estimate: "",
      start: "",
      due: "",
      tags: "",
      checklist: "",
      link: "",
    });
  });

  it("takes project, status and cycle presets", () => {
    const draft = newTaskDraft({
      project: "alpha",
      status: "FIELD",
      cycle: "C-01",
    });
    expect(draft).toMatchObject({
      project: "alpha",
      status: "FIELD",
      cycle: "C-01",
    });
  });
});

describe("toCreatePayload", () => {
  it("is null without a title", () => {
    expect(toCreatePayload({ ...newTaskDraft(), title: "  " })).toBeNull();
  });

  it("sends blanks as null and the Backlog cycle as no cycle", () => {
    expect(toCreatePayload({ ...newTaskDraft(), title: " New " })).toEqual({
      title: "New",
      project: null,
      status: "INTAKE",
      priority: "P2",
      task_type: null,
      cycle: null,
      assignee: null,
      estimate: null,
      start: null,
      due: null,
      tags: null,
      link: null,
      body: null,
      checklist: null,
    });
  });

  it("parses tags and one checklist item per non-empty line", () => {
    const payload = toCreatePayload({
      ...newTaskDraft({ project: "alpha", cycle: "C-01" }),
      title: "New",
      taskType: "FIX",
      assignee: " Kit ",
      tags: "ui, , board",
      checklist: "one\n\n  two \n",
      body: "  Brief  ",
    });
    expect(payload).toMatchObject({
      project: "alpha",
      cycle: "C-01",
      task_type: "FIX",
      assignee: "Kit",
      tags: ["ui", "board"],
      checklist: ["one", "two"],
      body: "Brief",
    });
  });
});
