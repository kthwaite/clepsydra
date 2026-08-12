import type { BoardTask } from "#/api/board";

export interface BoardFilter {
  text: string;
  pris: string[];
  holdOnly: boolean;
}

export const EMPTY_FILTER: BoardFilter = {
  text: "",
  pris: [],
  holdOnly: false,
};

export function isFilterActive(f: BoardFilter): boolean {
  return f.text.trim() !== "" || f.pris.length > 0 || f.holdOnly;
}

export function applyBoardFilter(
  tasks: BoardTask[],
  f: BoardFilter,
): BoardTask[] {
  if (!isFilterActive(f)) return tasks;

  const q = f.text.trim().toLowerCase();

  return tasks.filter((t) => {
    if (f.holdOnly && !t.hold) return false;
    if (f.pris.length > 0 && !f.pris.includes(t.priority)) return false;
    if (q === "") return true;

    const hay = [t.title, t.code, t.assignee ?? "", ...t.tags].join("\n");
    return hay.toLowerCase().includes(q);
  });
}
