import type { BoardTask } from "#/api/board";
import type { AgendaItem, AgendaResponse } from "#/api/tasks";
import { COL_ORDER } from "#/components/tasking/board-constants";

/** First prose paragraph of a markdown body, as plain text, for the mobile
 *  Today journal line. Null when the body has no prose. */
export function journalExcerpt(body: string, max = 180): string | null {
  const withoutFrontmatter = body.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const paragraph = withoutFrontmatter
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[.\]\s+)?/, ""))
        .join(" ")
        .trim(),
    )
    .find((text) => text.length > 0);
  if (!paragraph) return null;
  const plain = paragraph
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : plain.slice(0, max)).trimEnd()}…`;
}

export type AgendaBucketKey =
  | "overdue"
  | "today"
  | "week"
  | "later"
  | "undated";

export interface AgendaBucket {
  key: AgendaBucketKey;
  label: string;
  items: AgendaItem[];
}

function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** The mobile Agenda's sections: the server's buckets, with upcoming split
 *  at seven days. Empty sections are left out. */
export function bucketAgenda(
  data: AgendaResponse,
  today: string,
): AgendaBucket[] {
  const weekEnd = addDays(today, 7);
  const upcoming = data.upcoming ?? [];
  const buckets: AgendaBucket[] = [
    { key: "overdue", label: "Overdue", items: data.overdue ?? [] },
    { key: "today", label: "Today", items: data.today ?? [] },
    {
      key: "week",
      label: "This week",
      items: upcoming.filter((d) => d.date <= weekEnd).flatMap((d) => d.items),
    },
    {
      key: "later",
      label: "Later",
      items: upcoming.filter((d) => d.date > weekEnd).flatMap((d) => d.items),
    },
    { key: "undated", label: "No date", items: data.undated ?? [] },
  ];
  return buckets.filter((b) => b.items.length > 0);
}

export function agendaItemTitle(item: AgendaItem): string {
  return item.kind === "task" ? item.title : item.content;
}

export function agendaItemPath(item: AgendaItem): string {
  return item.kind === "task" ? item.path : item.page_path;
}

export function agendaItemKey(item: AgendaItem): string {
  return item.kind === "task"
    ? `task:${item.id}`
    : `todo:${item.page_path}:${item.span_start}`;
}

export type BoardStatus = (typeof COL_ORDER)[number];

const DONE_LIMIT = 20;

/** Board tasks per status column; Done keeps only the newest twenty. */
export function tasksByStatus(
  tasks: BoardTask[],
): Record<BoardStatus, BoardTask[]> {
  const groups = Object.fromEntries(
    COL_ORDER.map((status) => [status, [] as BoardTask[]]),
  ) as Record<BoardStatus, BoardTask[]>;
  for (const task of tasks) {
    groups[task.status as BoardStatus]?.push(task);
  }
  groups.SEALED = [...groups.SEALED]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, DONE_LIMIT);
  return groups;
}
