import { Cake, Square, SquareCheck } from "lucide-react";
import type { CalendarTodoItem } from "#/api/calendar";
import { CLink } from "#/components/codex/CLink";
import { Button } from "#/components/ui/button";
import { type BirthdayOccurrence, birthdayLabel } from "#/lib/birthday";
import type { CalendarEntryLike } from "#/lib/calendar/bucket";
import type { DateKey, WeekRow } from "#/lib/calendar/dates";
import { isTodoOpen } from "#/lib/calendar/todos";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { KIND_META } from "#/lib/kind";
import { parseLocalDate } from "#/lib/time";

export interface WeekRowsProps {
  rows: readonly WeekRow[];
  byDay: ReadonlyMap<DateKey, readonly CalendarEntryLike[]>;
  /** Birthdays per day, listed before the day's pages. */
  birthdaysByDay?: ReadonlyMap<DateKey, readonly BirthdayOccurrence[]>;
  /** Todos due per day, listed after birthdays and before pages. */
  todosByDay?: ReadonlyMap<DateKey, readonly CalendarTodoItem[]>;
  today: DateKey;
  /** The day whose side panel is open. */
  activeDate?: DateKey | null;
  onDayActivate: (key: DateKey) => void;
}

/** Todos and page titles listed inline per day; the rest open through the
 *  day panel. Birthdays are few and always listed. */
const MAX_INLINE = 8;

const NO_ENTRIES: readonly CalendarEntryLike[] = [];
const NO_BIRTHDAYS: readonly BirthdayOccurrence[] = [];
const NO_BIRTHDAY_DAYS: ReadonlyMap<DateKey, readonly BirthdayOccurrence[]> =
  new Map();
const NO_TODOS: readonly CalendarTodoItem[] = [];
const NO_TODO_DAYS: ReadonlyMap<DateKey, readonly CalendarTodoItem[]> =
  new Map();

const ROW_LINK = cn(
  "cl-link-plain flex min-w-0 items-center gap-1.5 rounded text-[13px] text-ink-2 hover:text-ink",
  FOCUS_RING_NATIVE,
);

function dayLabel(
  key: DateKey,
  count: number,
  birthdays: number,
  todos: number,
): string {
  const date = parseLocalDate(key).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const parts = [date];
  if (count > 0) parts.push(`${count} ${count === 1 ? "page" : "pages"}`);
  if (birthdays > 0) {
    parts.push(`${birthdays} ${birthdays === 1 ? "birthday" : "birthdays"}`);
  }
  if (todos > 0) parts.push(`${todos} ${todos === 1 ? "todo" : "todos"}`);
  return parts.join(", ");
}

/** A todo's line: an open or checked box, then its text; done ones are
 *  struck through and faint. */
function TodoLine({ item }: { item: CalendarTodoItem }) {
  const open = isTodoOpen(item);
  const Glyph = open ? Square : SquareCheck;
  const path = item.kind === "todo" ? item.page_path : item.path;
  const text = item.kind === "todo" ? item.content : item.title;
  return (
    <CLink path={path} className={ROW_LINK}>
      <Glyph
        data-todo-glyph
        aria-hidden="true"
        className="size-3 flex-shrink-0 text-mute"
      />
      <span
        className={cn("truncate", !open && "text-mute line-through")}
        title={path}
      >
        {text}
      </span>
    </CLink>
  );
}

const todoKey = (item: CalendarTodoItem) =>
  item.kind === "todo"
    ? `todo:${item.page_path}:${item.span_start}`
    : `task:${item.id}`;

function DayColumn({
  dateKey,
  entries,
  birthdays,
  todos,
  isToday,
  isActive,
  showMonth,
  onDayActivate,
}: {
  dateKey: DateKey;
  entries: readonly CalendarEntryLike[];
  birthdays: readonly BirthdayOccurrence[];
  todos: readonly CalendarTodoItem[];
  isToday: boolean;
  isActive: boolean;
  showMonth: boolean;
  onDayActivate: (key: DateKey) => void;
}) {
  const date = parseLocalDate(dateKey);
  const shownTodos = todos.slice(0, MAX_INLINE);
  const shown = entries.slice(0, MAX_INLINE - shownTodos.length);
  const hidden =
    todos.length + entries.length - shownTodos.length - shown.length;
  return (
    <div
      data-date={dateKey}
      data-today={isToday || undefined}
      data-active={isActive || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-[12px] bg-sink/40 p-2 md:min-h-40",
        isToday && "ring-1 ring-accent/50 ring-inset",
        isActive && "ring-2 ring-accent ring-inset",
      )}
    >
      <button
        type="button"
        aria-label={dayLabel(
          dateKey,
          entries.length,
          birthdays.length,
          todos.length,
        )}
        onClick={() => onDayActivate(dateKey)}
        className={cn(
          "flex items-baseline justify-between gap-2 rounded-[8px] px-1 py-0.5 text-left hover:bg-sink",
          FOCUS_RING_NATIVE,
        )}
      >
        <span className="flex items-baseline gap-1.5">
          <span className="text-[12px] text-mute">
            {date.toLocaleDateString(undefined, { weekday: "short" })}
          </span>
          <span
            className={cn(
              "text-[15px] leading-none tabular-nums",
              isToday ? "font-semibold text-accent" : "text-ink-2",
            )}
          >
            {date.getDate()}
          </span>
          {showMonth && (
            <span className="text-[12px] text-mute">
              {date.toLocaleDateString(undefined, { month: "short" })}
            </span>
          )}
        </span>
        {entries.length > 0 && (
          <span className="text-[12px] leading-none text-mute tabular-nums">
            {entries.length}
          </span>
        )}
      </button>
      {shown.length + shownTodos.length + birthdays.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {birthdays.map((b) => (
            <li key={`birthday:${b.path}`} className="min-w-0">
              <CLink path={b.path} className={ROW_LINK}>
                <Cake
                  data-birthday-marker
                  aria-hidden="true"
                  className="size-2.5 flex-shrink-0 text-accent"
                />
                <span className="truncate" title={b.path}>
                  {`${b.title || b.path} — ${birthdayLabel(b)}`}
                </span>
              </CLink>
            </li>
          ))}
          {shownTodos.map((item) => (
            <li key={todoKey(item)} className="min-w-0">
              <TodoLine item={item} />
            </li>
          ))}
          {shown.map((e) => (
            <li key={e.path} className="min-w-0">
              <CLink path={e.path} className={ROW_LINK}>
                <span
                  data-kind-dot
                  aria-hidden="true"
                  className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                  style={{ background: KIND_META[e.kind].color }}
                />
                <span className="truncate" title={e.path}>
                  {e.title || e.path}
                </span>
              </CLink>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start px-2"
          onPress={() => onDayActivate(dateKey)}
        >
          {`${hidden} more`}
        </Button>
      )}
    </div>
  );
}

/** Weeks mode: one row per ISO week, each day listing its birthdays, todos
 *  and pages inline. */
export function WeekRows({
  rows,
  byDay,
  birthdaysByDay = NO_BIRTHDAY_DAYS,
  todosByDay = NO_TODO_DAYS,
  today,
  activeDate = null,
  onDayActivate,
}: WeekRowsProps) {
  return (
    <div className="flex flex-col gap-6">
      {rows.map((row) => (
        <section
          key={row.days[0]}
          aria-label={`Week ${row.week}, ${row.isoYear}`}
          className="flex flex-col gap-2"
        >
          <h3 className="m-0 font-serif text-[16px] italic leading-none text-mute">
            Week {row.week}
          </h3>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-7">
            {row.days.map((key, i) => (
              <DayColumn
                key={key}
                dateKey={key}
                entries={byDay.get(key) ?? NO_ENTRIES}
                birthdays={birthdaysByDay.get(key) ?? NO_BIRTHDAYS}
                todos={todosByDay.get(key) ?? NO_TODOS}
                isToday={key === today}
                isActive={key === activeDate}
                showMonth={i === 0 || key.endsWith("-01")}
                onDayActivate={onDayActivate}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
