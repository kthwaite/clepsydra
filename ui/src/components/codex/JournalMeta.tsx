import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAiJournalRecent } from "#/api/aiJournal";
import { useJournalRecent } from "#/api/journal";
import { Button } from "#/components/ui/button";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import {
  aiJournalDateFromPath,
  aiJournalPathForDate,
  fastiRows,
  journalDateFromPath,
  journalPathForDate,
  nearestEntry,
  relativeDays,
} from "#/lib/journal";
import type { KindMetaExtrasProps } from "#/lib/kindPresentation";
import {
  dayOfYear,
  formatDayMonth,
  isLeapYear,
  localDateKey,
  parseLocalDate,
} from "#/lib/time";
import { useWorkspaceStore } from "#/store/workspace";

const FASTI_ROWS = 14;
const FETCH_DAYS = 30;

/** Round sink step buttons either side of Today (36px, as mocked). */
const NAV_ICON = "h-9 w-9 bg-sink text-ink-2";

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
    <div className="flex flex-col gap-5">
      <div className="flex gap-1.5">
        <Button
          size="icon"
          className={NAV_ICON}
          isDisabled={!prevKey}
          onPress={() => prevKey && goTo(prevKey)}
          aria-label="previous entry"
        >
          <ChevronLeft size={14} strokeWidth={2} aria-hidden />
        </Button>
        <Button
          size="sm"
          className="h-9 rounded-full px-4 text-[14px] font-normal"
          isDisabled={dateKey === todayKey}
          onPress={() => goTo(todayKey)}
        >
          Today
        </Button>
        <Button
          size="icon"
          className={NAV_ICON}
          isDisabled={!nextKey}
          onPress={() => nextKey && goTo(nextKey)}
          aria-label="next entry"
        >
          <ChevronRight size={14} strokeWidth={2} aria-hidden />
        </Button>
      </div>

      <div className="flex flex-col">
        {rows.map((r) => {
          const active = r.dateKey === dateKey;
          const written = r.path !== null;
          const navigable = written || r.dateKey === todayKey;
          return (
            <button
              key={r.dateKey}
              type="button"
              disabled={!navigable}
              aria-current={active ? "date" : undefined}
              onClick={() => navigable && goTo(r.dateKey)}
              className={cn(
                "-ml-2 grid h-[26px] grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 rounded-full pr-2.5 pl-2 text-left transition-colors",
                FOCUS_RING_NATIVE,
                active && "bg-sink",
                navigable && !active && "cursor-pointer hover:bg-sink/60",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "h-[7px] w-[7px] rounded-full",
                  written ? "bg-accent" : "ring-[1.3px] ring-faint ring-inset",
                )}
              />
              <span
                className={cn(
                  "font-serif text-[16.5px] leading-none",
                  active
                    ? "text-ink"
                    : navigable
                      ? "text-ink-2 italic"
                      : "text-mute italic",
                )}
              >
                {formatDayMonth(r.dateKey)}
              </span>
              <span className="text-[12.5px] text-mute">
                {relativeDays(r.dateKey, todayKey)}
              </span>
            </button>
          );
        })}
      </div>

      <dl className="m-0 grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13.5px] leading-[1.4]">
        <dt className="text-mute">Day</dt>
        <dd className="m-0 text-ink">
          <span className="font-serif text-[18px]">{dayOfYear(date)}</span>
          <span className="text-mute"> of {yearDays}</span>
        </dd>
        <dt className="text-mute">State</dt>
        <dd className="m-0 text-ink">{isDraft ? "Unwritten" : "Written"}</dd>
        <dt className="text-mute">{spec.counterpart.label}</dt>
        <dd className="m-0">
          <button
            type="button"
            className={cn(
              "rounded-sm text-left",
              FOCUS_RING_NATIVE,
              counterpartNavigable
                ? "cursor-pointer text-accent hover:underline hover:underline-offset-[3px]"
                : "text-mute",
            )}
            disabled={!counterpartNavigable}
            onClick={openCounterpart}
          >
            {counterpartPath !== null ? "Written · open" : "Unwritten"}
          </button>
        </dd>
      </dl>
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
