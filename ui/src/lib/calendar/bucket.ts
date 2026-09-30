// Turns flat calendar entries into local-day buckets. Journal kinds with a
// journal_date sit on that date; everything else sits on the local date of
// created_at. Entries outside the requested range are trimmed (the server
// pads the journal window by a day).

import type { DateKey } from "#/lib/calendar/dates";
import { KINDS, type Kind } from "#/lib/kind";
import { localDateKey } from "#/lib/time";

export interface CalendarEntryLike {
  path: string;
  title?: string | null;
  kind: Kind;
  created_at?: string | null;
  journal_date?: string | null;
}

export const JOURNAL_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "JOURNAL",
  "AI_JOURNAL",
]);

/** Journal kinds first, then KINDS order. */
const KIND_RANK: ReadonlyMap<Kind, number> = new Map(
  [
    ...KINDS.filter((k) => JOURNAL_KINDS.has(k)),
    ...KINDS.filter((k) => !JOURNAL_KINDS.has(k)),
  ].map((k, i) => [k, i]),
);

const rank = (kind: Kind): number => KIND_RANK.get(kind) ?? KIND_RANK.size;

export function placementKey(e: CalendarEntryLike): DateKey | null {
  if (JOURNAL_KINDS.has(e.kind) && e.journal_date) return e.journal_date;
  if (!e.created_at) return null;
  const created = new Date(e.created_at);
  return Number.isNaN(created.getTime()) ? null : localDateKey(created);
}

function compareEntries(a: CalendarEntryLike, b: CalendarEntryLike): number {
  const journalA = JOURNAL_KINDS.has(a.kind) ? 0 : 1;
  const journalB = JOURNAL_KINDS.has(b.kind) ? 0 : 1;
  if (journalA !== journalB) return journalA - journalB;
  const byTitle = (a.title ?? a.path).localeCompare(b.title ?? b.path);
  if (byTitle !== 0) return byTitle;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Buckets by placement key within `[first, last]`; each day is sorted. Empty days have no key. */
export function bucketEntries<E extends CalendarEntryLike>(
  entries: readonly E[],
  range: { first: DateKey; last: DateKey },
  hiddenKinds?: ReadonlySet<Kind>,
): Map<DateKey, E[]> {
  const out = new Map<DateKey, E[]>();
  for (const entry of entries) {
    if (hiddenKinds?.has(entry.kind)) continue;
    const key = placementKey(entry);
    if (key === null || key < range.first || key > range.last) continue;
    const day = out.get(key);
    if (day) day.push(entry);
    else out.set(key, [entry]);
  }
  for (const day of out.values()) day.sort(compareEntries);
  return out;
}

/** Distinct kinds, journal kinds first then KINDS order, capped at `max`. */
export function dayKinds(
  entries: readonly CalendarEntryLike[],
  max = 4,
): Kind[] {
  const kinds = [...new Set(entries.map((e) => e.kind))];
  return kinds.sort((a, b) => rank(a) - rank(b)).slice(0, max);
}

/** Groups in dayKinds order (uncapped); each group keeps the input order. */
export function groupByKind<E extends CalendarEntryLike>(
  entries: readonly E[],
): Array<{ kind: Kind; entries: E[] }> {
  const groups = new Map<Kind, E[]>();
  for (const entry of entries) {
    const group = groups.get(entry.kind);
    if (group) group.push(entry);
    else groups.set(entry.kind, [entry]);
  }
  return dayKinds(entries, Number.POSITIVE_INFINITY).map((kind) => ({
    kind,
    entries: groups.get(kind) ?? [],
  }));
}
