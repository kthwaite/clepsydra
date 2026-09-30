import { parseDate } from "@internationalized/date";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  CalendarStateContext,
  type DateValue,
} from "react-aria-components";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { type CalendarEntryLike, dayKinds } from "#/lib/calendar/bucket";
import { addMonths, type DateKey, monthGrid } from "#/lib/calendar/dates";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";
import { KIND_META } from "#/lib/kind";
import { parseLocalDate } from "#/lib/time";

export type MonthCalendarVariant = "rail" | "page";

export interface MonthCalendarProps {
  /** Any day in the first visible month. */
  visibleMonth: DateKey;
  /** Prev/next/Today and keyboard paging. Keyboard paging sends the first day
   *  of the new first visible month. */
  onVisibleMonthChange: (key: DateKey) => void;
  /** Month grids shown side by side. Default 1. */
  months?: number;
  byDay: ReadonlyMap<DateKey, readonly CalendarEntryLike[]>;
  today: DateKey;
  /** Rail: the open page's date. */
  selectedDate?: DateKey | null;
  /** The day whose popover or panel is open. */
  activeDate?: DateKey | null;
  onDayActivate: (key: DateKey, cell: HTMLElement) => void;
  /** rail = dots, 32px rows; page = dots + count, taller rows. */
  variant: MonthCalendarVariant;
  /** The screen puts its mode switch here. */
  headerExtra?: ReactNode;
  className?: string;
}

const NO_ENTRIES: readonly CalendarEntryLike[] = [];

/** Header row, cell rows and week-number rows share these heights, so the
 *  aria-hidden week column lines up with RAC's grid rows. */
const HEAD_ROW = "h-7";
const ROW: Record<MonthCalendarVariant, string> = {
  rail: "h-8",
  page: "h-24",
};

// RAC forwards every Calendar prop to useCalendarState, but its public types
// omit `selectionAlignment`. "start" puts the focused month first, so a
// remount at `visibleMonth` shows that month in the first grid.
const ALIGN_START = { selectionAlignment: "start" } as object;

const monthOf = (key: DateKey) => key.slice(0, 7);
const firstOfMonth = (key: DateKey): DateKey => `${monthOf(key)}-01`;

function ymOf(key: DateKey): [number, number] {
  const [y, m] = key.split("-").map(Number);
  return [y, m - 1];
}

function monthTitle(first: DateKey, months: number): ReactNode {
  const start = parseLocalDate(first);
  if (months <= 1) {
    return (
      <>
        {start.toLocaleDateString(undefined, { month: "long" })}{" "}
        <span className="text-mute">{start.getFullYear()}</span>
      </>
    );
  }
  const end = parseLocalDate(addMonths(first, months - 1));
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).formatRange(start, end);
}

/** Reports RAC's first visible day whenever it moves. */
function StartWatcher({ onStart }: { onStart: (key: DateKey) => void }) {
  const state = useContext(CalendarStateContext);
  const start = state?.visibleRange.start.toString();
  useEffect(() => {
    if (start) onStart(start);
  }, [start, onStart]);
  return null;
}

function useVisibleStart(offset: number): DateKey | null {
  const state = useContext(CalendarStateContext);
  if (!state) return null;
  return state.visibleRange.start.add({ months: offset }).toString();
}

function MonthCaption({ offset }: { offset: number }) {
  const first = useVisibleStart(offset);
  if (!first) return null;
  return (
    <div
      aria-hidden="true"
      className="pl-8 font-serif text-[16px] italic leading-none text-mute"
    >
      {parseLocalDate(first).toLocaleDateString(undefined, { month: "long" })}
    </div>
  );
}

function WeekColumn({
  offset,
  variant,
}: {
  offset: number;
  variant: MonthCalendarVariant;
}) {
  const first = useVisibleStart(offset);
  if (!first) return null;
  const [y, m] = ymOf(first);
  return (
    <div
      data-week-column
      aria-hidden="true"
      className="flex w-7 flex-col text-[12px] text-faint tabular-nums"
    >
      <div className={cn(HEAD_ROW, "flex items-center justify-center")}>W</div>
      {monthGrid(y, m).map((row) => (
        <div
          key={row.days[0]}
          data-week-number
          className={cn(
            ROW[variant],
            "flex justify-center",
            variant === "rail" ? "items-center" : "items-start pt-2",
          )}
        >
          {row.week}
        </div>
      ))}
    </div>
  );
}

function KindDots({
  entries,
  dim,
}: {
  entries: readonly CalendarEntryLike[];
  dim: boolean;
}) {
  const kinds = dayKinds(entries);
  if (kinds.length === 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cn("flex items-center gap-[3px]", dim && "opacity-50")}
    >
      {kinds.map((kind) => (
        <span
          key={kind}
          data-kind-dot
          data-kind={kind}
          className="h-1 w-1 rounded-full"
          style={{ background: KIND_META[kind].color }}
        />
      ))}
    </span>
  );
}

interface DayFaceProps {
  dateKey: DateKey;
  label: string;
  entries: readonly CalendarEntryLike[];
  variant: MonthCalendarVariant;
  isToday: boolean;
  isSelected: boolean;
  isActive: boolean;
  isOutside: boolean;
}

/** The visible day. Our own state attributes live here, because RAC writes
 *  its own `data-today` (from the real clock) and `data-selected` on the
 *  cell button. */
function DayFace({
  dateKey,
  label,
  entries,
  variant,
  isToday,
  isSelected,
  isActive,
  isOutside,
}: DayFaceProps) {
  const count = entries.length;
  return (
    <span
      data-date={dateKey}
      data-today={isToday || undefined}
      data-selected={isSelected || undefined}
      data-active={isActive || undefined}
      data-outside={isOutside || undefined}
      className={cn(
        "absolute inset-[2px] flex rounded-[10px] transition-colors",
        variant === "rail"
          ? "flex-col items-center justify-center gap-[3px]"
          : "flex-col justify-between p-2",
        isOutside ? "text-faint" : "text-ink-2",
        isSelected && "bg-accent-tint text-ink",
        isToday && "text-accent ring-1 ring-accent/50 ring-inset",
        isActive && "ring-2 ring-accent ring-inset",
      )}
    >
      {variant === "rail" ? (
        <>
          <span
            className={cn(
              "text-[13px] leading-none tabular-nums",
              isToday && "font-semibold",
            )}
          >
            {label}
          </span>
          <KindDots entries={entries} dim={isOutside} />
        </>
      ) : (
        <>
          <span className="flex items-baseline justify-between gap-1">
            <span
              className={cn(
                "text-[14px] leading-none tabular-nums",
                isToday && "font-semibold",
              )}
            >
              {label}
            </span>
            {count > 0 && (
              <span
                data-day-count
                aria-hidden="true"
                className="text-[12px] leading-none text-mute tabular-nums"
              >
                {count}
              </span>
            )}
          </span>
          <KindDots entries={entries} dim={isOutside} />
        </>
      )}
    </span>
  );
}

/** Obsidian-calendar-style month grid(s) over react-aria's Calendar: Monday
 *  first, ISO week numbers, kind dots, today ring, selected and active days. */
export function MonthCalendar({
  visibleMonth,
  onVisibleMonthChange,
  months = 1,
  byDay,
  today,
  selectedDate = null,
  activeDate = null,
  onDayActivate,
  variant,
  headerExtra,
  className,
}: MonthCalendarProps) {
  // RAC owns the focused day; the parent owns the first visible month. RAC
  // moves its visible start on keyboard paging, which we report upward. A
  // parent change RAC did not cause remounts the Calendar at the new month.
  const [focused, setFocused] = useState<DateKey>(visibleMonth);
  const [epoch, setEpoch] = useState(0);
  const [start, setStart] = useState<DateKey>(firstOfMonth(visibleMonth));
  const startRef = useRef<DateKey>(firstOfMonth(visibleMonth));
  const visibleMonthRef = useRef(visibleMonth);
  visibleMonthRef.current = visibleMonth;
  const onChangeRef = useRef(onVisibleMonthChange);
  onChangeRef.current = onVisibleMonthChange;
  const cellRefs = useRef(new Map<DateKey, HTMLElement>());

  const handleStart = useCallback((key: DateKey) => {
    if (key === startRef.current) return;
    startRef.current = key;
    setStart(key);
    if (monthOf(key) !== monthOf(visibleMonthRef.current)) {
      onChangeRef.current(key);
    }
  }, []);

  useEffect(() => {
    if (monthOf(visibleMonth) === monthOf(startRef.current)) return;
    startRef.current = firstOfMonth(visibleMonth);
    setStart(startRef.current);
    setFocused(visibleMonth);
    setEpoch((n) => n + 1);
  }, [visibleMonth]);

  const handleChange = (date: DateValue) => {
    const key = date.toString();
    const cell = cellRefs.current.get(key);
    if (cell) onDayActivate(key, cell);
  };

  const count = Math.max(1, months);
  const rowClass = ROW[variant];

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        variant === "rail" ? "gap-2" : "gap-4",
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3
          className={cn(
            "m-0 mr-auto truncate font-serif italic leading-none text-ink",
            variant === "rail" ? "text-[18px]" : "text-[24px]",
          )}
        >
          {monthTitle(start, count)}
        </h3>
        {headerExtra}
        <div className="flex items-center gap-0.5">
          <IconButton
            aria-label="Previous month"
            onPress={() => onVisibleMonthChange(addMonths(start, -1))}
          >
            <ChevronLeft aria-hidden="true" />
          </IconButton>
          <Button
            variant="ghost"
            size="sm"
            className="px-2.5"
            onPress={() => onVisibleMonthChange(today)}
          >
            Today
          </Button>
          <IconButton
            aria-label="Next month"
            onPress={() => onVisibleMonthChange(addMonths(start, 1))}
          >
            <ChevronRight aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <Calendar
        key={epoch}
        {...ALIGN_START}
        aria-label="Calendar"
        firstDayOfWeek="mon"
        value={null}
        onChange={handleChange}
        focusedValue={parseDate(focused)}
        onFocusChange={(d) => setFocused(d.toString())}
        visibleDuration={{ months: count }}
        className={cn(
          "grid gap-x-8 gap-y-6",
          count > 1 &&
            "grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))]",
        )}
      >
        <StartWatcher onStart={handleStart} />
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: offsets are stable positions
          <div key={i} className="flex min-w-0 flex-col gap-2">
            {count > 1 && <MonthCaption offset={i} />}
            <div className="grid grid-cols-[auto_1fr]">
              <WeekColumn offset={i} variant={variant} />
              <CalendarGrid
                offset={{ months: i }}
                weekdayStyle="short"
                className="w-full table-fixed border-collapse"
              >
                <CalendarGridHeader>
                  {(day) => (
                    <CalendarHeaderCell
                      className={cn(
                        HEAD_ROW,
                        "p-0 text-center align-middle text-[12px] font-normal text-faint",
                      )}
                    >
                      {day}
                    </CalendarHeaderCell>
                  )}
                </CalendarGridHeader>
                <CalendarGridBody>
                  {(date) => {
                    const key = date.toString();
                    return (
                      <CalendarCell
                        date={date}
                        ref={(el) => {
                          if (el) cellRefs.current.set(key, el);
                        }}
                        className={cn(
                          "relative block w-full cursor-pointer rounded-[12px] data-[disabled]:cursor-default data-[hovered]:bg-sink/60",
                          rowClass,
                          FOCUS_RING,
                        )}
                      >
                        {({ formattedDate, isOutsideMonth }) => (
                          <DayFace
                            dateKey={key}
                            label={formattedDate}
                            entries={byDay.get(key) ?? NO_ENTRIES}
                            variant={variant}
                            isToday={key === today}
                            isSelected={key === selectedDate}
                            isActive={key === activeDate}
                            isOutside={isOutsideMonth}
                          />
                        )}
                      </CalendarCell>
                    );
                  }}
                </CalendarGridBody>
              </CalendarGrid>
            </div>
          </div>
        ))}
      </Calendar>
    </div>
  );
}
