import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useCalendarEntries } from "#/api/calendar";
import { useTags } from "#/api/index";
import { DayNotesList } from "#/components/calendar/DayNotesList";
import { MonthCalendar } from "#/components/calendar/MonthCalendar";
import { WeekRows } from "#/components/calendar/WeekRows";
import { FilterBar } from "#/components/filters/FilterBar";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { SegmentedControl } from "#/components/ui/segmented-control";
import { BottomSheet } from "#/components/ui/sheet";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { useOpenJournalForDate } from "#/hooks/useOpenJournalForDate";
import { bucketEntries, type CalendarEntryLike } from "#/lib/calendar/bucket";
import {
  type CalendarMode,
  type DateKey,
  dayRange,
  rangeForView,
  rangeKeys,
  type WeekRow,
  weekRows,
} from "#/lib/calendar/dates";
import {
  type CalendarViewSearch,
  DEFAULT_SPAN,
  SPANS,
} from "#/lib/calendar/search";
import type { FilterField, FilterState } from "#/lib/filters/model";
import {
  KINDS,
  type Kind,
  kindDisplayLabel,
  sortKindsByLabel,
} from "#/lib/kind";
import { isoAddDays, localDateKey } from "#/lib/time";
import { useProjectValues } from "#/lib/useProjects";

export interface CalendarScreenProps {
  view: CalendarViewSearch;
  filterState: FilterState;
  onViewChange: (patch: Partial<CalendarViewSearch>) => void;
  onFilterChange: (next: FilterState) => void;
}

const MODE_OPTIONS = [
  { id: "month", label: "Month" },
  { id: "months", label: "Months" },
  { id: "weeks", label: "Weeks" },
] as const;

const SPAN_UNIT: Record<CalendarMode, [string, string]> = {
  month: ["month", "months"],
  months: ["month", "months"],
  weeks: ["week", "weeks"],
};

const CAP = 5000;
const NO_ENTRIES: readonly CalendarEntryLike[] = [];
const KIND_OPTIONS = sortKindsByLabel(KINDS).map((kind) => ({
  value: kind,
  label: kindDisplayLabel(kind),
}));

function spanOptions(mode: CalendarMode) {
  const [one, many] = SPAN_UNIT[mode];
  return SPANS[mode].map((n) => ({
    id: String(n),
    label: `${n} ${n === 1 ? one : many}`,
  }));
}

function weeksTitle(rows: readonly WeekRow[]): string {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first.week === last.week && first.isoYear === last.isoYear) {
    return `Week ${first.week}, ${first.isoYear}`;
  }
  if (first.isoYear === last.isoYear) {
    return `Weeks ${first.week}–${last.week}, ${first.isoYear}`;
  }
  return `Week ${first.week}, ${first.isoYear} – week ${last.week}, ${last.isoYear}`;
}

function WeeksHeader({
  rows,
  anchor,
  today,
  onAnchorChange,
}: {
  rows: readonly WeekRow[];
  anchor: DateKey;
  today: DateKey;
  onAnchorChange: (key: DateKey) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <h3 className="m-0 mr-auto truncate font-serif text-[24px] italic leading-none text-ink">
        {weeksTitle(rows)}
      </h3>
      <div className="flex items-center gap-0.5">
        <IconButton
          aria-label="Previous week"
          onPress={() => onAnchorChange(isoAddDays(anchor, -7))}
        >
          <ChevronLeft aria-hidden="true" />
        </IconButton>
        <Button
          variant="ghost"
          size="sm"
          className="px-2.5"
          onPress={() => onAnchorChange(today)}
        >
          Today
        </Button>
        <IconButton
          aria-label="Next week"
          onPress={() => onAnchorChange(isoAddDays(anchor, 7))}
        >
          <ChevronRight aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}

/** The `/calendar` screen: pages by the day they were made, in Month,
 *  Months or Weeks mode, filtered on the server. Plain props, so it renders
 *  without the router. */
export function CalendarScreen({
  view,
  filterState,
  onViewChange,
  onFilterChange,
}: CalendarScreenProps) {
  const today = localDateKey(new Date());
  const anchor = view.date ?? today;
  const mobile = useMobileLayout();
  const openJournal = useOpenJournalForDate();
  const projects = useProjectValues();
  const { data: tagIndex } = useTags();

  const filterFields: FilterField[] = useMemo(
    () => [
      { id: "kind", kind: "multi", label: "Kind", options: KIND_OPTIONS },
      {
        id: "tag",
        kind: "single",
        label: "Tag",
        options: (tagIndex ?? []).map((t) => ({ value: t.tag })),
      },
      {
        id: "project",
        kind: "single",
        label: "Project",
        options: projects.map((value) => ({ value })),
      },
    ],
    [tagIndex, projects],
  );

  const range = useMemo(
    () => rangeForView({ mode: view.mode, anchor, span: view.span }),
    [view.mode, anchor, view.span],
  );
  const facets = filterState.facets;
  const filters = {
    kinds: facets.kind as readonly Kind[] | undefined,
    tag: facets.tag?.[0],
    project: facets.project?.[0],
  };
  const query = useCalendarEntries({ range, ...filters });
  const entries = query.data?.entries;
  const visibleKeys = useMemo(() => rangeKeys(range), [range]);
  const byDay = useMemo(
    () => bucketEntries(entries ?? [], visibleKeys),
    [entries, visibleKeys],
  );

  // A selected day outside the visible range (e.g. a shared link) gets its
  // own one-day window with the same filters.
  const day = view.day;
  const dayOutside =
    day !== undefined && (day < visibleKeys.first || day > visibleKeys.last);
  const oneDay = useMemo(() => dayRange(day ?? anchor), [day, anchor]);
  const dayQuery = useCalendarEntries(
    { range: oneDay, ...filters },
    { enabled: dayOutside },
  );
  const dayQueryEntries = dayQuery.data?.entries;
  const outsideByDay = useMemo(
    () =>
      dayOutside
        ? bucketEntries(dayQueryEntries ?? [], rangeKeys(oneDay))
        : null,
    [dayOutside, dayQueryEntries, oneDay],
  );
  const dayLoading =
    dayOutside && (dayQuery.isLoading || dayQuery.isPlaceholderData === true);

  const setAnchor = useCallback(
    (date: DateKey) => onViewChange({ date }),
    [onViewChange],
  );
  const activateDay = useCallback(
    (day: DateKey) => onViewChange({ day }),
    [onViewChange],
  );
  const closeDay = useCallback(
    () => onViewChange({ day: undefined }),
    [onViewChange],
  );

  const dayEntries =
    day && !dayLoading
      ? ((outsideByDay ?? byDay).get(day) ?? NO_ENTRIES)
      : NO_ENTRIES;
  const journalPath = dayEntries.find((e) => e.kind === "JOURNAL")?.path;
  const dayList = day ? (
    <DayNotesList
      dateKey={day}
      today={today}
      entries={dayEntries}
      loading={dayLoading}
      journalPath={journalPath}
      onOpenJournal={() => void openJournal(day, journalPath)}
    />
  ) : null;

  const modeControls = (
    <div className="flex flex-wrap items-center gap-3">
      <SegmentedControl
        label="Mode"
        value={view.mode}
        options={MODE_OPTIONS}
        onChange={(next) => {
          const mode = next as CalendarMode;
          onViewChange({ mode, span: DEFAULT_SPAN[mode] });
        }}
      />
      {view.mode !== "month" && (
        <SegmentedControl
          label="Span"
          value={String(view.span)}
          options={spanOptions(view.mode)}
          onChange={(next) => onViewChange({ span: Number(next) })}
        />
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-4 px-4 pt-8 md:px-10 md:pt-10">
        <h1 className="m-0 font-serif text-[40px] font-normal leading-none text-ink md:text-[56px]">
          Calendar
        </h1>
        <FilterBar
          fields={filterFields}
          primaryFieldIds={["kind", "tag", "project"]}
          state={filterState}
          onChange={onFilterChange}
          showText={false}
        />
        {modeControls}
        {query.isLoading ? (
          <p role="status" className="m-0 text-[14px] text-mute">
            Loading Calendar…
          </p>
        ) : query.isError ? (
          <p role="alert" className="m-0 text-[14px] text-hot">
            Couldn’t load Calendar.
          </p>
        ) : query.data?.truncated ? (
          <p className="m-0 text-[14px] text-warn">
            Showing the first {CAP} pages. Narrow the filters to see the rest.
          </p>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-6 md:px-10">
          {view.mode === "weeks" ? (
            <WeeksBody
              anchor={anchor}
              span={view.span}
              today={today}
              byDay={byDay}
              activeDate={day ?? null}
              onAnchorChange={setAnchor}
              onDayActivate={activateDay}
            />
          ) : (
            <MonthCalendar
              visibleMonth={anchor}
              onVisibleMonthChange={setAnchor}
              months={view.mode === "months" ? view.span : 1}
              byDay={byDay}
              today={today}
              activeDate={day ?? null}
              onDayActivate={(key) => activateDay(key)}
              variant={view.mode === "months" ? "compact" : "page"}
            />
          )}
        </div>
        {dayList && !mobile && (
          <aside
            aria-label="Day"
            className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto bg-sink/40 px-5 py-6"
          >
            <div className="flex justify-end">
              <IconButton aria-label="Close day" onPress={closeDay}>
                <X aria-hidden="true" />
              </IconButton>
            </div>
            {dayList}
          </aside>
        )}
      </div>
      {mobile && (
        <BottomSheet
          isOpen={dayList !== null}
          onOpenChange={(open) => {
            if (!open) closeDay();
          }}
          aria-label="Day"
        >
          {dayList}
        </BottomSheet>
      )}
    </div>
  );
}

function WeeksBody({
  anchor,
  span,
  today,
  byDay,
  activeDate,
  onAnchorChange,
  onDayActivate,
}: {
  anchor: DateKey;
  span: number;
  today: DateKey;
  byDay: ReadonlyMap<DateKey, readonly CalendarEntryLike[]>;
  activeDate: DateKey | null;
  onAnchorChange: (key: DateKey) => void;
  onDayActivate: (key: DateKey) => void;
}) {
  const rows = useMemo(() => weekRows(anchor, span), [anchor, span]);
  return (
    <div className="flex flex-col gap-4">
      <WeeksHeader
        rows={rows}
        anchor={anchor}
        today={today}
        onAnchorChange={onAnchorChange}
      />
      <WeekRows
        rows={rows}
        byDay={byDay}
        today={today}
        activeDate={activeDate}
        onDayActivate={onDayActivate}
      />
    </div>
  );
}
