import type { BoardTask } from "#/api/board";

export interface ChecklistProgress {
  done: number;
  total: number;
  percent: number;
  isComplete: boolean;
}

export function checklistProgress(checks: number[]): ChecklistProgress {
  const hasProgress = checks.length >= 2;
  const done = hasProgress ? checks[0] : 0;
  const total = hasProgress ? checks[1] : 0;
  return {
    done,
    total,
    percent: total > 0 ? (done / total) * 100 : 0,
    isComplete: total > 0 && done === total,
  };
}

export interface CycleStatsResult {
  committed: number;
  sealed: number;
  field: number;
  hold: number;
  checkDone: number;
  checkTot: number;
  pct: number;
}

export function cycleStats(items: BoardTask[]): CycleStatsResult {
  const committed = items.length;
  let sealed = 0;
  let field = 0;
  let hold = 0;
  let checkDone = 0;
  let checkTot = 0;

  for (const item of items) {
    if (item.status === "SEALED") sealed += 1;
    if (item.status === "FIELD") field += 1;
    if (item.hold) hold += 1;
    const progress = checklistProgress(item.checks);
    checkDone += progress.done;
    checkTot += progress.total;
  }

  return {
    committed,
    sealed,
    field,
    hold,
    checkDone,
    checkTot,
    pct: committed ? Math.round((sealed / committed) * 100) : 0,
  };
}

export interface SealStatsResult {
  committed: number;
  sealed: number;
  carryover: number;
  pct: number;
}

export function sealStats(tasks: BoardTask[], code: string): SealStatsResult {
  const base = cycleStats(tasks.filter((task) => task.cycle === code));
  return {
    committed: base.committed,
    sealed: base.sealed,
    carryover: base.committed - base.sealed,
    pct: base.pct,
  };
}
