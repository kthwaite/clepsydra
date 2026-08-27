import { isoAddDays, localDateKey, parseLocalDate } from "#/lib/time";

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Matches `<prefix>/YYYY-MM-DD.md` (legacy) and
 *  `<prefix>/<yyyymmdd>.YYYY-MM-DD.<shortid>.md` (canonical). */
const streamPathRe = (prefix: string) =>
  new RegExp(
    `^${prefix}/(?:\\d{8}\\.)?(\\d{4}-\\d{2}-\\d{2})(?:\\.[A-Za-z0-9]{8})?\\.md$`,
  );
const JOURNAL_PATH_RE = streamPathRe("journals");
const AI_JOURNAL_PATH_RE = streamPathRe("ai-journals");

export function journalPathForDate(dateKey: string): string {
  return `journals/${dateKey}.md`;
}

/** Deterministic path for today's journal — the editor binds here before the
 *  file exists (accepted coupling to the server-side vault layout; see the
 *  2026-08-06 journal-create-on-first-write design). */
export function todayJournalPath(): string {
  return journalPathForDate(localDateKey(new Date()));
}

export function journalDateFromPath(path: string): string | null {
  const m = path.match(JOURNAL_PATH_RE);
  return m ? m[1] : null;
}

export function aiJournalPathForDate(dateKey: string): string {
  return `ai-journals/${dateKey}.md`;
}

/** Deterministic draft path for today's AI journal — same accepted coupling
 *  to the server vault layout as todayJournalPath. */
export function todayAiJournalPath(): string {
  return aiJournalPathForDate(localDateKey(new Date()));
}

export function aiJournalDateFromPath(path: string): string | null {
  const m = path.match(AI_JOURNAL_PATH_RE);
  return m ? m[1] : null;
}

/** Shared FOLIO day-label formatting: "Friday 7 August 2026" for a resolved
 *  date key, falling back to the raw title when neither path nor title
 *  carries a stream date. */
function dayLabel(dateKey: string | null, title: string): string {
  if (!dateKey) return title;
  return parseLocalDate(dateKey).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** FOLIO title for JOURNAL pages: "Friday 7 August 2026". Falls back to the
 *  raw title when neither path nor title carries a journal date. */
export function journalDayLabel(path: string, title: string): string {
  const dateKey =
    journalDateFromPath(path) ?? (DATE_KEY_RE.test(title) ? title : null);
  return dayLabel(dateKey, title);
}

/** FOLIO title for AI JOURNAL pages, same shape as journalDayLabel. */
export function aiJournalDayLabel(path: string, title: string): string {
  const dateKey =
    aiJournalDateFromPath(path) ?? (DATE_KEY_RE.test(title) ? title : null);
  return dayLabel(dateKey, title);
}

/** Nearest written day strictly before (-1) or after (+1) `from`, or null.
 *  Date keys compare lexicographically. */
export function nearestEntry(
  writtenKeys: readonly string[],
  from: string,
  direction: -1 | 1,
): string | null {
  let best: string | null = null;
  for (const k of writtenKeys) {
    if (direction === -1 ? k >= from : k <= from) continue;
    if (best === null || (direction === -1 ? k > best : k < best)) best = k;
  }
  return best;
}

export type FastiRow = { dateKey: string; path: string | null };

/** The `count` most recent calendar days ending at `todayKey`, newest first,
 *  each resolved to its journal path or null for a skipped day. */
export function fastiRows(
  entries: readonly { path: string; journal_date: string }[],
  todayKey: string,
  count: number,
): FastiRow[] {
  const byDate = new Map(entries.map((e) => [e.journal_date, e.path]));
  return Array.from({ length: count }, (_, i) => {
    const dateKey = isoAddDays(todayKey, -i);
    return { dateKey, path: byDate.get(dateKey) ?? null };
  });
}

export function shortDate(dateKey: string): string {
  const d = parseLocalDate(dateKey);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

export function relativeDays(dateKey: string, todayKey: string): string {
  if (dateKey === todayKey) return "today";
  const ms =
    parseLocalDate(todayKey).getTime() - parseLocalDate(dateKey).getTime();
  const diff = Math.round(ms / 86_400_000);
  return diff > 0 ? `${diff}d` : "—";
}
