import { Circle, CircleDot } from "lucide-react";
import { useAiJournalRecent } from "#/api/aiJournal";
import { useJournalRecent } from "#/api/journal";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import {
  aiJournalDateFromPath,
  aiJournalPathForDate,
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

type StreamEntry = { path: string; journal_date: string };

/** Parameterizes JournalStreamMeta over one of the two journal streams
 *  (human vs AI): which recent-entries hook and path helpers drive day nav,
 *  and how to reach the sibling stream's same-date page for the cross-link
 *  row. */
type StreamSpec = {
  useRecent: (days: number) => { data?: StreamEntry[] };
  pathForDate: (key: string) => string;
  dateFromPath: (path: string) => string | null;
  counterpart: {
    label: string; // row label: "AI journal" on the human rail, "Journal" on the AI rail
    useRecent: (days: number) => { data?: StreamEntry[] };
    pathForDate: (key: string) => string;
  };
};

/** JOURNAL/AI_JOURNAL META-rail block: day navigation over written entries,
 *  the FASTI recent timeline, this-day marginalia, and a cross-link row to
 *  the sibling stream's same-date page. Day nav repoints the hosting tab in
 *  place (updateTabPath) — the same follow mechanism as kind/project
 *  assignment — rather than opening a tab per day. */
function JournalStreamMeta({
  spec,
  path,
  tabId,
  isDraft,
}: { spec: StreamSpec } & KindMetaExtrasProps) {
  const { data: recent } = spec.useRecent(FETCH_DAYS);
  const { data: counterpartRecent } = spec.counterpart.useRecent(FETCH_DAYS);
  const updateTabPath = useWorkspaceStore((s) => s.updateTabPath);
  const openTab = useOpenTab();

  const todayKey = localDateKey(new Date());
  const dateKey = spec.dateFromPath(path) ?? todayKey;
  const entries = recent ?? [];
  // Today is always navigable: it can draft even before the file exists.
  const writtenKeys = [
    ...new Set([...entries.map((e) => e.journal_date), todayKey]),
  ];

  // Prefer the real indexed path; the draft shape exists only for today.
  const byDate = new Map(entries.map((e) => [e.journal_date, e.path]));
  const goTo = (key: string) =>
    updateTabPath(tabId, byDate.get(key) ?? spec.pathForDate(key), key);

  const counterpartByDate = new Map(
    (counterpartRecent ?? []).map((e) => [e.journal_date, e.path]),
  );
  const counterpartPath = counterpartByDate.get(dateKey) ?? null;
  const counterpartNavigable = counterpartPath !== null || dateKey === todayKey;
  const openCounterpart = () =>
    openTab(
      "page",
      counterpartPath ?? spec.counterpart.pathForDate(dateKey),
      dateKey,
    );

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
        <div className="flex justify-between">
          <span className="text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            {spec.counterpart.label}
          </span>
          <button
            type="button"
            className={cn(
              "text-ink-2",
              counterpartNavigable
                ? "cursor-pointer underline decoration-dotted hover:text-ink"
                : "opacity-50",
            )}
            disabled={!counterpartNavigable}
            onClick={openCounterpart}
          >
            {counterpartPath !== null ? "written · open" : "unwritten"}
          </button>
        </div>
      </div>
    </div>
  );
}

// useRecent wraps each hook in a closure rather than assigning it directly:
// a bare `useJournalRecent` reference here would read the (possibly mocked)
// "#/api/journal" export as soon as this module loads — i.e. wherever
// kindPresentation.tsx is imported — rather than only when the owning
// component actually renders.
const HUMAN_SPEC: StreamSpec = {
  useRecent: (days) => useJournalRecent(days),
  pathForDate: journalPathForDate,
  dateFromPath: journalDateFromPath,
  counterpart: {
    label: "AI journal",
    useRecent: (days) => useAiJournalRecent(days),
    pathForDate: aiJournalPathForDate,
  },
};

const AI_SPEC: StreamSpec = {
  useRecent: (days) => useAiJournalRecent(days),
  pathForDate: aiJournalPathForDate,
  dateFromPath: aiJournalDateFromPath,
  counterpart: {
    label: "Journal",
    useRecent: (days) => useJournalRecent(days),
    pathForDate: journalPathForDate,
  },
};

export function JournalMeta(props: KindMetaExtrasProps) {
  return <JournalStreamMeta spec={HUMAN_SPEC} {...props} />;
}

export function AiJournalMeta(props: KindMetaExtrasProps) {
  return <JournalStreamMeta spec={AI_SPEC} {...props} />;
}
