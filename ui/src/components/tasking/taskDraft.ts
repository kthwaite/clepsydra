/**
 * Task Draft: the Task Fields as the board's forms hold them, and the codec
 * between a draft and the wire (CONTEXT.md: Task Fields, Task Patch).
 *
 * A draft holds every text field as a string, as its input does; tags are
 * one comma-separated string. `diffToPatch` follows the server's Task Patch
 * contract: an unchanged field is omitted, an emptied clearable field is
 * cleared (sent as null), and title, tags and the hold reason are never
 * cleared by an edit.
 */

import type {
  BoardTask,
  CreateTaskRequest,
  PatchTaskRequest,
} from "#/api/board";
import { DEFAULT_PRIORITY, DEFAULT_STATUS } from "./board-constants";

/** The Cycle sentinel that means "no Cycle" in the board's pickers. */
export const BACKLOG_CYCLE = "BACKLOG";

/** An edited Task's text fields, as the edit panel's inputs hold them. */
export interface TaskDraft {
  title: string;
  assignee: string;
  estimate: string;
  start: string;
  due: string;
  /** The hold reason; only edited while the Task is held. */
  hold: string;
  link: string;
  /** Comma-separated. */
  tags: string;
}

/** A new Task, as the create form holds it. */
export interface NewTaskDraft extends Omit<TaskDraft, "hold"> {
  body: string;
  project: string;
  /** A Cycle code, or BACKLOG_CYCLE. */
  cycle: string;
  status: string;
  priority: string;
  taskType: string | null;
  /** One checklist item per line. */
  checklist: string;
}

/** Trims a text value; a blank value becomes null. */
export function blankToNull(value: string): string | null {
  return value.trim() || null;
}

/** Splits comma-separated tags, trimming each and dropping empties. */
export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseChecklist(value: string): string[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The draft of an existing Task: its text fields as input strings. */
export function fromTask(task: BoardTask): TaskDraft {
  return {
    title: task.title,
    assignee: task.assignee ?? "",
    estimate: task.estimate ?? "",
    start: task.start ?? "",
    due: task.due ?? "",
    hold: task.hold ?? "",
    link: task.link ?? "",
    tags: task.tags.join(", "),
  };
}

/** A blank new-Task draft with the board's defaults and any presets. */
export function newTaskDraft(
  preset: { project?: string; status?: string; cycle?: string } = {},
): NewTaskDraft {
  return {
    title: "",
    body: "",
    project: preset.project ?? "",
    cycle: preset.cycle ?? BACKLOG_CYCLE,
    status: preset.status ?? DEFAULT_STATUS,
    priority: DEFAULT_PRIORITY,
    taskType: null,
    assignee: "",
    estimate: "",
    start: "",
    due: "",
    tags: "",
    checklist: "",
    link: "",
  };
}

/** The create request for a draft, or null when the title is blank. */
export function toCreatePayload(draft: NewTaskDraft): CreateTaskRequest | null {
  const title = draft.title.trim();
  if (!title) return null;
  const tags = parseTags(draft.tags);
  const checklist = parseChecklist(draft.checklist);
  return {
    title,
    project: draft.project || null,
    status: draft.status || null,
    priority: draft.priority || null,
    task_type: draft.taskType,
    cycle: draft.cycle === BACKLOG_CYCLE ? null : draft.cycle || null,
    assignee: blankToNull(draft.assignee),
    estimate: blankToNull(draft.estimate),
    start: blankToNull(draft.start),
    due: blankToNull(draft.due),
    tags: tags.length ? tags : null,
    link: blankToNull(draft.link),
    body: blankToNull(draft.body),
    checklist: checklist.length ? checklist : null,
  };
}

/** The clearable text fields: blank clears, anything else sets. */
const CLEARABLE = ["assignee", "estimate", "start", "due", "link"] as const;

/**
 * The Task Patch from a Task to the fields present in `draft`. Fields the
 * draft leaves out, and fields equal to the Task's, are omitted.
 */
export function diffToPatch(
  task: BoardTask,
  draft: Partial<TaskDraft>,
): PatchTaskRequest {
  const patch: PatchTaskRequest = {};

  if (draft.title !== undefined) {
    const title = draft.title.trim();
    if (title && title !== task.title) patch.title = title;
  }

  for (const field of CLEARABLE) {
    const value = draft[field];
    if (value === undefined) continue;
    const next = blankToNull(value);
    if (next !== (task[field] ?? null)) patch[field] = next;
  }

  // The reason input exists only while held. An emptied reason keeps the
  // current one: clearing the hold is the toggle's job (hold: null).
  if (draft.hold !== undefined && task.hold) {
    const hold = draft.hold.trim() || task.hold;
    if (hold !== task.hold) patch.hold = hold;
  }

  if (draft.tags !== undefined) {
    const tags = parseTags(draft.tags);
    if (tags.join(",") !== task.tags.join(",")) patch.tags = tags;
  }

  return patch;
}
