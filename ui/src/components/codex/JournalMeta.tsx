import { Circle, CircleDot } from "lucide-react";
import { useJournalRecent } from "#/api/journal";
import { cn } from "#/lib/cn";
import {
  fastiRows,
  journalDateFromPath,
  journalPathForDate,
  nearestEntry,
  relativeDays,
  shortDate,
} from "#/lib/journal";
import type { KindMetaExtrasProps } from "#/lib/kindPresentation";
import {
  dayOfYear,
  isLeapYear,
  localDateKey,
  parseLocalDate,
} from "#/lib/time";
import { useWorkspaceStore } from "#/store/workspace";

const FASTI_ROWS = 14;
const FETCH_DAYS = 30;

/** JOURNAL-kind META-rail block: day navigation over written entries, the
 *  FASTI recent timeline, and this-day marginalia. Day nav repoints the
 *  hosting tab in place (updateTabPath) — the same follow mechanism as
 *  kind/project assignment — rather than opening a tab per day. */
export function JournalMeta({ path, tabId, isDraft }: KindMetaExtrasProps) {
  const { data: recent } = useJournalRecent(FETCH_DAYS);
  const updateTabPath = useWorkspaceStore((s) => s.updateTabPath);

  const todayKey = localDateKey(new Date());
  const dateKey = journalDateFromPath(path) ?? todayKey;
  const entries = recent ?? [];
  // Today is always navigable: it can draft even before the file exists.
  const writtenKeys = [
    ...new Set([...entries.map((e) => e.journal_date), todayKey]),
  ];

  const goTo = (key: string) =>
    updateTabPath(tabId, journalPathForDate(key), key);

  const prevKey = nearestEntry(writtenKeys, dateKey, -1);
  const nextKey = nearestEntry(writtenKeys, dateKey, 1);
  const rows = fastiRows(entries, todayKey, FASTI_ROWS);
  const date = parseLocalDate(dateKey);
  const yearDays = isLeapYear(date.getFullYear()) ? 366 : 365;

  return (
    <div>
      <div className="flex gap-1">
        <button
          type="button"
          className="cl-btn"
          disabled={!prevKey}
          onClick={() => prevKey && goTo(prevKey)}
          aria-label="previous entry"
        >
          ‹
        </button>
        <button
          type="button"
          className="cl-btn"
          disabled={dateKey === todayKey}
          onClick={() => goTo(todayKey)}
        >
          Today
        </button>
        <button
          type="button"
          className="cl-btn"
          disabled={!nextKey}
          onClick={() => nextKey && goTo(nextKey)}
          aria-label="next entry"
        >
          ›
        </button>
      </div>

      <div className="mt-2 border-l border-rule pl-2">
        {rows.map((r) => {
          const active = r.dateKey === dateKey;
          const navigable = r.path !== null || r.dateKey === todayKey;
          return (
            <button
              key={r.dateKey}
              type="button"
              disabled={!navigable}
              onClick={() => navigable && goTo(r.dateKey)}
              className={cn(
                "grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-[6px] py-[1px] text-left text-[10px]",
                active
                  ? "text-ink"
                  : navigable
                    ? "cursor-pointer text-ink-mute hover:text-ink"
                    : "text-ink-mute opacity-50",
              )}
            >
              {r.path !== null ? (
                <CircleDot size={10} className="text-accent" aria-hidden />
              ) : (
                <Circle size={10} aria-hidden />
              )}
              <span
                className={cn(
                  "cl-serif",
                  active ? "font-semibold not-italic" : "italic",
                )}
              >
                {shortDate(r.dateKey)}
              </span>
              <span className="cl-mono text-[9px]">
                {relativeDays(r.dateKey, todayKey)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="cl-mono mt-3 flex flex-col gap-1 text-[11px]">
        <div className="flex justify-between">
          <span className="text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            Day
          </span>
          <span className="text-ink-2">
            {dayOfYear(date)} / {yearDays}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            State
          </span>
          <span className="text-ink-2">
            {isDraft ? "unwritten" : "written"}
          </span>
        </div>
      </div>
    </div>
  );
}
