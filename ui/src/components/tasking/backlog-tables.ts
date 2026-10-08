import type { BoardCycle, BoardTask } from "#/api/board";
import { COL_ORDER, isDone, PRI_ORDER } from "./board-constants";

interface BacklogSplit {
  /** The active cycle's tasks; null when no cycle is active. */
  cycle: BoardTask[] | null;
  /** Every other task. */
  backlog: BoardTask[];
}

/** Position in `order`; values outside it sort after every known one. */
function rank(order: readonly string[], value: string): number {
  const at = order.indexOf(value);
  return at === -1 ? order.length : at;
}

/**
 * Priority P0→P3, then status (COL_ORDER), then due date ascending; tasks
 * with no due date sort last. ISO dates compare as plain strings.
 */
function compareTasks(a: BoardTask, b: BoardTask): number {
  const priority = rank(PRI_ORDER, a.priority) - rank(PRI_ORDER, b.priority);
  if (priority !== 0) return priority;
  const status = rank(COL_ORDER, a.status) - rank(COL_ORDER, b.status);
  if (status !== 0) return status;
  const aDue = a.due ?? "9";
  const bDue = b.due ?? "9";
  return aDue < bDue ? -1 : aDue > bDue ? 1 : 0;
}

/**
 * Splits the list view's tasks into the active cycle's table and the
 * backlog table, each sorted by `compareTasks`. The active cycle is the
 * one BoardHeader shows (`state === "ACTIVE"`). SEALED tasks are left out
 * unless `showDone`.
 */
export function splitBacklog(
  tasks: readonly BoardTask[],
  activeCycle: BoardCycle | null,
  { showDone }: { showDone: boolean },
): BacklogSplit {
  const shown = (
    showDone ? [...tasks] : tasks.filter((t) => !isDone(t.status))
  ).sort(compareTasks);
  if (!activeCycle) return { cycle: null, backlog: shown };
  return {
    cycle: shown.filter((t) => t.cycle === activeCycle.code),
    backlog: shown.filter((t) => t.cycle !== activeCycle.code),
  };
}
