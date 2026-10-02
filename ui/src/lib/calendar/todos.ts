// Places dated todos on calendar days. A todo's `due` is already a local
// `YYYY-MM-DD` date, so there is no timezone conversion. Items outside the
// requested range are trimmed (the server pads the window by a day).

import type { CalendarTodoItem } from "#/api/calendar";
import type { DateKey } from "#/lib/calendar/dates";

/** Open: a checkbox todo that is todo or doing; a TASK not yet SEALED. */
export function isTodoOpen(item: CalendarTodoItem): boolean {
  return item.kind === "todo"
    ? item.status === "todo" || item.status === "doing"
    : item.status !== "SEALED";
}

/** Buckets by `due` within `[first, last]`; each day keeps the input order. */
export function bucketTodos(
  items: readonly CalendarTodoItem[],
  range: { first: DateKey; last: DateKey },
): Map<DateKey, CalendarTodoItem[]> {
  const out = new Map<DateKey, CalendarTodoItem[]>();
  for (const item of items) {
    const key = item.due;
    if (key < range.first || key > range.last) continue;
    const day = out.get(key);
    if (day) day.push(item);
    else out.set(key, [item]);
  }
  return out;
}
