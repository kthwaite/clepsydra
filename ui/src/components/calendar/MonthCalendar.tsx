import { parseDate } from "@internationalized/date";
import { Cake, ChevronLeft, ChevronRight, ListTodo } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
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
import type { CalendarTodoItem } from "#/api/calendar";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import type { BirthdayOccurrence } from "#/lib/birthday";
import { type CalendarEntryLike, dayKinds } from "#/lib/calendar/bucket";
import { addMonths, type DateKey, monthGrid } from "#/lib/calendar/dates";
import { isTodoOpen } from "#/lib/calendar/todos";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";
import { KIND_META } from "#/lib/kind";
import { parseLocalDate } from "#/lib/time";

export type MonthCalendarVariant = "rail" | "compact" | "page";

export interface MonthCalendarProps {
  /** Any day in the first visible month. */
  visibleMonth: DateKey;
  /** Prev/next/Today and keyboard paging. Keyboard paging sends the first day
   *  of the new first visible month. */
  onVisibleMonthChange: (key: DateKey) => void;
  /** Month grids shown side by side. Default 1. */
  months?: number;
  byDay: ReadonlyMap<DateKey, readonly CalendarEntryLike[]>;
  /** Birthdays per day; a day with any shows a cake beside its dots. */
  birthdaysByDay?: ReadonlyMap<DateKey, readonly BirthdayOccurrence[]>;
  /** Dated todos per day; a day with any shows a todo marker (plus the open
   *  count in the page variant). */
  todosByDay?: ReadonlyMap<DateKey, readonly CalendarTodoItem[]>;
  today: DateKey;
  /** Rail: the open page's date. */
  selectedDate?: DateKey | null;
  /** The day whose popover or panel is open. */
  activeDate?: DateKey | null;
  onDayActivate: (key: DateKey, cell: HTMLElement) => void;
  /** rail = dots, 32px rows; compact = dots in slightly roomier tiles (the
   *  Months planner); page = tall tiles with dots + count. */
  variant: MonthCalendarVariant;
  /** The screen puts its filters and mode switch here. */
  headerExtra?: ReactNode;
  /** Single month only: rows stretch to fill the parent's height, never
   *  shorter than the variant's row height. */
  fill?: boolean;
  className?: string;
}

const NO_ENTRIES: readonly CalendarEntryLike[] = [];
const NO_BIRTHDAYS: ReadonlyMap<DateKey, readonly BirthdayOccurrence[]> =
  new Map();
const NO_TODO_DAYS: ReadonlyMap<DateKey, readonly CalendarTodoItem[]> =
  new Map();
const NO_TODOS: readonly CalendarTodoItem[] = [];

/** A day's todo tally: all of them, and those still open. */
interface TodoTally {
  total: number;
  open: number;
}

function tallyTodos(todos: readonly CalendarTodoItem[]): TodoTally {
  return { total: todos.length, open: todos.filter(isTodoOpen).length };
}

/** Header row, cell rows and week-number rows share these heights, so the
 *  aria-hidden week column lines up with RAC's grid rows. */
const HEAD_ROW = "h-7";
const ROW: Record<MonthCalendarVariant, string> = {
  rail: "h-8",
  compact: "h-10",
  page: "h-24",
};
/** Fill mode's row height; `--cal-row` is set on the grid's size container. */
const FILL_ROW = "h-[var(--cal-row)]";
const FILL_MIN_ROW = "6rem";

// RAC forwards every Calendar prop to useCalendarState, but its public types
// omit `selectionAlignment`. "start" puts the focused month first, so a
// remount at `visibleMonth` shows that month in the first grid.
const ALIGN_START = { selectionAlignment: "start" } as object;

const monthOf = (key: DateKey) => key.slice(0, 7);
const firstOfMonth = (key: DateKey): DateKey => `${monthOf(key)}-01`;

/** An overflow click waiting for the parent to show `month`; then `day`
 *  takes keyboard focus. */
interface PendingFocus {
  month: string;
  day: DateKey;
}

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
  rowClass,
}: {
  offset: number;
  variant: MonthCalendarVariant;
  rowClass: string;
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
            rowClass,
            "flex justify-center",
            variant === "page" ? "items-start pt-3" : "items-center",
          )}
        >
          {row.week}
        </div>
      ))}
    </div>
  );
}

/** A checklist glyph when the day has todos; the page variant adds the open
 *  count. Faint once every todo is done. */
function TodoMarker({
  todos,
  variant,
}: {
  todos: TodoTally;
  variant: MonthCalendarVariant;
}) {
  const allDone = todos.open === 0;
  return (
    <span
      data-todo-marker
      data-all-done={allDone || undefined}
      className={cn(
        "flex shrink-0 items-center gap-0.5 text-[12px] leading-none tabular-nums",
        allDone ? "text-faint" : "text-ink-2",
      )}
    >
      <ListTodo
        aria-hidden="true"
        strokeWidth={2.25}
        className={variant === "page" ? "size-3" : "size-2.5"}
      />
      {variant === "page" && !allDone && todos.open}
    </span>
  );
}

/** The day's markers: a cake when someone has a birthday, a todo glyph when
 *  something is due, then kind dots. */
function DayMarkers({
  entries,
  birthdays,
  todos,
  variant,
  dim,
}: {
  entries: readonly CalendarEntryLike[];
  birthdays: number;
  todos: TodoTally;
  variant: MonthCalendarVariant;
  dim: boolean;
}) {
  const kinds = dayKinds(entries);
  if (kinds.length === 0 && birthdays === 0 && todos.total === 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cn("flex items-center gap-[3px]", dim && "opacity-50")}
    >
      {birthdays > 0 && (
        <Cake
          data-birthday-marker
          aria-hidden="true"
          strokeWidth={2.25}
          className={cn(
            "shrink-0 text-accent",
            variant === "page" ? "size-3" : "size-2.5",
          )}
        />
      )}
      {todos.total > 0 && <TodoMarker todos={todos} variant={variant} />}
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

const plural = (n: number, one: string, many: string) =>
  n === 1 ? `1 ${one}` : `${n} ${many}`;

/** "2 open todos", "3 todos, 1 open", "2 todos, all done". */
function todoDescription({ total, open }: TodoTally): string {
  if (open === total) return `${total} open ${total === 1 ? "todo" : "todos"}`;
  const all = plural(total, "todo", "todos");
  return open === 0 ? `${all}, all done` : `${all}, ${open} open`;
}

/** "2 notes, 1 birthday", "1 birthday", "3 notes, 2 open todos". */
function dayDescription(
  notes: number,
  birthdays: number,
  todos: TodoTally,
): string {
  return [
    notes > 0 && plural(notes, "note", "notes"),
    birthdays > 0 && plural(birthdays, "birthday", "birthdays"),
    todos.total > 0 && todoDescription(todos),
  ]
    .filter(Boolean)
    .join(", ");
}

/** Screen-reader note, birthday and todo counts. RAC's cell button carries its own aria-label,
 *  which wins over content, and CalendarCell forwards no aria props. So this
 *  text points the enclosing cell button at itself via aria-describedby. RAC
 *  leaves that attribute unset for a single-date calendar with no
 *  validation, so React never overwrites it. */
function NoteCount({ text }: { text: string }) {
  const id = useId();
  const describe = useCallback(
    (el: HTMLSpanElement | null) => {
      const button = el?.closest<HTMLElement>('[role="button"]');
      if (!button) return;
      button.setAttribute("aria-describedby", id);
      return () => {
        if (button.getAttribute("aria-describedby") === id) {
          button.removeAttribute("aria-describedby");
        }
      };
    },
    [id],
  );
  return (
    <span ref={describe} id={id} className="sr-only">
      {text}
    </span>
  );
}

interface DayFaceProps {
  dateKey: DateKey;
  label: string;
  entries: readonly CalendarEntryLike[];
  birthdays: number;
  todos: readonly CalendarTodoItem[];
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
  birthdays,
  todos,
  variant,
  isToday,
  isSelected,
  isActive,
  isOutside,
}: DayFaceProps) {
  const count = entries.length;
  const tally = tallyTodos(todos);
  const markers = (
    <DayMarkers
      entries={entries}
      birthdays={birthdays}
      todos={tally}
      variant={variant}
      dim={isOutside}
    />
  );
  return (
    <span
      data-date={dateKey}
      data-today={isToday || undefined}
      data-selected={isSelected || undefined}
      data-active={isActive || undefined}
      data-outside={isOutside || undefined}
      data-variant={variant}
      className={cn(
        "absolute flex transition-colors",
        variant === "page"
          ? "inset-[3px] flex-col justify-between rounded-[12px] p-2"
          : variant === "compact"
            ? "inset-[2px] flex-col items-center justify-center gap-1 rounded-[10px]"
            : "inset-[2px] flex-col items-center justify-center gap-[3px] rounded-[10px]",
        variant !== "rail" &&
          (isOutside
            ? "bg-sink/15 group-hover:bg-sink/30"
            : "bg-sink/40 group-hover:bg-sink/70"),
        isOutside ? "text-faint" : "text-ink-2",
        isSelected && "bg-accent-tint text-ink",
        isToday && "text-accent ring-1 ring-accent/50 ring-inset",
        isActive && "ring-2 ring-accent ring-inset",
      )}
    >
      {(count > 0 || birthdays > 0 || tally.total > 0) && (
        <NoteCount text={dayDescription(count, birthdays, tally)} />
      )}
      {variant === "page" ? (
        <>
          <span className="flex items-baseline gap-1.5">
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
          {markers}
        </>
      ) : (
        <>
          <span
            className={cn(
              "leading-none tabular-nums",
              variant === "compact" ? "text-[14px]" : "text-[13px]",
              isToday && "font-semibold",
            )}
          >
            {label}
          </span>
          <span data-marker-slot className="flex h-2.5 items-center">
            {markers}
          </span>
        </>
      )}
    </span>
  );
}

/** Obsidian-calendar-style month grid(s) over react-aria's Calendar: Monday
 *  first, ISO week numbers, kind dots, birthday cakes and todo glyphs, today ring, selected and active days. */
export function MonthCalendar({
  visibleMonth,
  onVisibleMonthChange,
  months = 1,
  byDay,
  birthdaysByDay = NO_BIRTHDAYS,
  todosByDay = NO_TODO_DAYS,
  today,
  selectedDate = null,
  activeDate = null,
  onDayActivate,
  variant,
  headerExtra,
  fill = false,
  className,
}: MonthCalendarProps) {
  // RAC owns the focused day; the parent owns the first visible month. RAC
  // moves its visible start on keyboard paging, which we report upward. A
  // parent change RAC did not cause remounts the Calendar at the new month.
  const [focused, setFocused] = useState<DateKey>(visibleMonth);
  const [epoch, setEpoch] = useState(0);
  // True only for a remount caused by an overflow click, so prev/next and
  // other parent changes never move focus into the grid.
  const [autoFocus, setAutoFocus] = useState(false);
  const pendingRef = useRef<PendingFocus | null>(null);
  const jumpDayRef = useRef<DateKey | null>(null);
  const [start, setStart] = useState<DateKey>(firstOfMonth(visibleMonth));
  const startRef = useRef<DateKey>(firstOfMonth(visibleMonth));
  const visibleMonthRef = useRef(visibleMonth);
  visibleMonthRef.current = visibleMonth;
  const onChangeRef = useRef(onVisibleMonthChange);
  onChangeRef.current = onVisibleMonthChange;
  const rootRef = useRef<HTMLDivElement>(null);

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
    const pending = pendingRef.current;
    pendingRef.current = null;
    const jump = pending?.month === monthOf(visibleMonth) ? pending : null;
    startRef.current = firstOfMonth(visibleMonth);
    setStart(startRef.current);
    // Mount focused on visibleMonth, so RAC's start alignment keeps it
    // first; the jump day (possibly in a later grid) takes focus after.
    jumpDayRef.current = jump?.day ?? null;
    setFocused(visibleMonth);
    setAutoFocus(jump !== null);
    setEpoch((n) => n + 1);
  }, [visibleMonth]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per remount
  useEffect(() => {
    const day = jumpDayRef.current;
    if (!day) return;
    jumpDayRef.current = null;
    setFocused(day);
  }, [epoch]);

  // Resolve the live cell at activation. In Months mode a date can show in
  // two grids; RAC disables the outside-month copy, so the in-month face is
  // the one pressed.
  const handleChange = (date: DateValue) => {
    const key = date.toString();
    const face =
      rootRef.current?.querySelector(
        `[data-date="${key}"]:not([data-outside])`,
      ) ?? rootRef.current?.querySelector(`[data-date="${key}"]`);
    const cell = face?.closest<HTMLElement>("td");
    if (cell) onDayActivate(key, cell);
  };

  const count = Math.max(1, months);
  const filling = fill && count === 1;
  const rowClass = filling ? FILL_ROW : ROW[variant];
  const weeks = monthGrid(...ymOf(start)).length;
  // HEAD_ROW is h-7 (1.75rem); the rows share what is left.
  const fillStyle = filling
    ? ({
        "--cal-row": `max(${FILL_MIN_ROW}, calc((100cqh - 1.75rem) / ${weeks}))`,
        minHeight: `calc(1.75rem + ${FILL_MIN_ROW} * ${weeks})`,
      } as CSSProperties)
    : undefined;

  // RAC disables outside-month cells, so their presses never reach
  // onChange. A delegated click handles them: a date inside the visible
  // range (Months mode) activates its in-month copy; a date before or after
  // it shifts the view one month and focuses that date after the remount.
  // Keyboard users cross month edges with the arrow keys instead.
  const onOverflowRef = useRef<(key: DateKey) => void>(() => {});
  onOverflowRef.current = (key: DateKey) => {
    const last = addMonths(start, count);
    if (key >= start && key < last) {
      handleChange(parseDate(key));
      return;
    }
    const target = addMonths(start, key < start ? -1 : 1);
    pendingRef.current = { month: monthOf(target), day: key };
    onVisibleMonthChange(target);
  };
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      // The face sits inset in its cell, so a click can land on either.
      const cell = (e.target as Element | null)?.closest("td");
      const face = cell?.querySelector<HTMLElement>(
        "[data-date][data-outside]",
      );
      const key = face?.dataset.date;
      if (!key || !root.contains(cell ?? null)) return;
      onOverflowRef.current(key);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);

  return (
    <div
      ref={rootRef}
      className={cn(
        "flex min-w-0 flex-col",
        variant === "rail" ? "gap-2" : "gap-4",
        filling && "h-full",
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
        autoFocus={autoFocus}
        aria-label="Calendar"
        firstDayOfWeek="mon"
        value={null}
        onChange={handleChange}
        focusedValue={parseDate(focused)}
        onFocusChange={(d) => setFocused(d.toString())}
        visibleDuration={{ months: count }}
        className={cn(
          "grid gap-x-8 gap-y-6",
          filling && "min-h-0 flex-1",
          count > 1 &&
            (variant === "compact"
              ? "grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))]"
              : "grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))]"),
        )}
      >
        <StartWatcher onStart={handleStart} />
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: offsets are stable positions
          <div key={i} className="flex min-w-0 flex-col gap-2">
            {count > 1 && <MonthCaption offset={i} />}
            <div
              className={cn(
                "grid grid-cols-[auto_1fr]",
                filling && "min-h-0 flex-1 [container-type:size]",
              )}
              style={fillStyle}
            >
              <WeekColumn offset={i} variant={variant} rowClass={rowClass} />
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
                        "p-0 align-middle text-[12px] font-normal text-faint",
                        variant === "page"
                          ? "pl-[11px] text-left"
                          : "text-center",
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
                        className={cn(
                          "group relative block w-full cursor-pointer rounded-[12px]",
                          variant === "rail" && "hover:bg-sink/60",
                          rowClass,
                          FOCUS_RING,
                        )}
                      >
                        {({ formattedDate, isOutsideMonth }) => (
                          <DayFace
                            dateKey={key}
                            label={formattedDate}
                            entries={byDay.get(key) ?? NO_ENTRIES}
                            birthdays={birthdaysByDay.get(key)?.length ?? 0}
                            todos={todosByDay.get(key) ?? NO_TODOS}
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
