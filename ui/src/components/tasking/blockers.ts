/**
 * Pure Blocker helpers for the Tasking board.
 *
 * A Blocker is a Task another Task waits on. The waiting Task stores the
 * Blocker codes in `blocked_by`. A Blocker is open while it is on the board
 * and not Done (`SEALED`). A code with no Task on the board is dangling; it
 * is listed but never open.
 */

import type { BoardTask } from "#/api/board";

/** The status a start warning guards. */
export const START_STATUS = "FIELD";

/** Maps each board Task code to its Task. */
export function indexByCode(
  tasks: readonly BoardTask[],
): Map<string, BoardTask> {
  return new Map(tasks.map((t) => [t.code, t]));
}

/** True when the Blocker exists on the board and is not Done. */
export function isOpenBlocker(blocker: BoardTask | undefined | null): boolean {
  return blocker != null && blocker.status !== "SEALED";
}

/** The Task's open Blockers, in stored order. */
export function openBlockers(
  task: BoardTask,
  tasks: readonly BoardTask[],
): BoardTask[] {
  const byCode = indexByCode(tasks);
  return task.blocked_by.flatMap((code) => {
    const blocker = byCode.get(code);
    return blocker && isOpenBlocker(blocker) ? [blocker] : [];
  });
}

/**
 * The open Blockers to warn about when `task` moves to `nextStatus`.
 * Empty unless the move starts the Task (any status → In Progress).
 */
export function startWarningBlockers(
  task: BoardTask,
  nextStatus: string,
  tasks: readonly BoardTask[],
): BoardTask[] {
  if (nextStatus !== START_STATUS || task.status === START_STATUS) return [];
  return openBlockers(task, tasks);
}

/** One Blocker entry on a card: the Task, or null for a dangling code. */
export interface CardBlocker {
  code: string;
  task: BoardTask | null;
}

/**
 * The Blockers a card shows: open ones and dangling ones, in stored order.
 * Done Blockers no longer block, so the card drops them.
 */
export function cardBlockers(
  task: BoardTask,
  byCode: ReadonlyMap<string, BoardTask>,
): CardBlocker[] {
  return task.blocked_by.flatMap<CardBlocker>((code) => {
    const blocker = byCode.get(code);
    if (!blocker) return [{ code, task: null }];
    return isOpenBlocker(blocker) ? [{ code, task: blocker }] : [];
  });
}
