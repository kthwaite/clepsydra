import { Cake, CalendarDays, ListTodo } from "lucide-react";
import type { ReactNode } from "react";
import type { CalendarTodoItem } from "#/api/calendar";
import { TaskRow, TodoRow } from "#/components/agenda/TodoRows";
import { CLink } from "#/components/codex/CLink";
import { KindIcon } from "#/components/KindIcon";
import { Button } from "#/components/ui/button";
import { type BirthdayOccurrence, birthdayLabel } from "#/lib/birthday";
import { type CalendarEntryLike, groupByKind } from "#/lib/calendar/bucket";
import type { DateKey } from "#/lib/calendar/dates";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { KIND_META, kindDisplayLabel } from "#/lib/kind";
import { localDateKey, parseLocalDate } from "#/lib/time";

export interface DayNotesListProps {
  dateKey: DateKey;
  entries: readonly CalendarEntryLike[];
  /** Birthdays falling on the day, listed first. */
  birthdays?: readonly BirthdayOccurrence[];
  /** Todos due on the day, listed after birthdays. Their rows toggle status
   *  in place. */
  todos?: readonly CalendarTodoItem[];
  /** The day's journal, when one is written. */
  journalPath?: string | null;
  /** Today's key; defaults to the local clock. A past or future day with no
   *  journal offers "Create journal". */
  today?: DateKey;
  /** The day's entries are still loading: don't claim the day is empty. */
  loading?: boolean;
  onOpenJournal: () => void;
  headingLevel?: 3 | 4;
  className?: string;
}

const NO_BIRTHDAYS: readonly BirthdayOccurrence[] = [];
const NO_TODOS: readonly CalendarTodoItem[] = [];

const ROW_LINK = cn(
  "cl-link-plain flex min-w-0 items-center gap-2 rounded text-[14px] text-ink-2 hover:text-ink",
  FOCUS_RING_NATIVE,
);

function GroupHeader({
  marker,
  label,
  count,
}: {
  marker: ReactNode;
  label: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-mute">
      {marker}
      <span>{label}</span>
      <span className="text-faint">{count}</span>
    </div>
  );
}

function BirthdayGroup({
  birthdays,
}: {
  birthdays: readonly BirthdayOccurrence[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <GroupHeader
        marker={
          <Cake
            aria-hidden="true"
            className="size-3 flex-shrink-0 text-accent"
          />
        }
        label="Birthdays"
        count={birthdays.length}
      />
      <ul
        aria-label="Birthdays"
        className="m-0 flex list-none flex-col gap-2 p-0"
      >
        {birthdays.map((b) => (
          <li key={b.path} className="min-w-0">
            <CLink path={b.path} className={ROW_LINK}>
              <KindIcon kind="PERSON" tone="mono" className="flex-shrink-0" />
              <span className="truncate" title={b.path}>
                {`${b.title || b.path} — ${birthdayLabel(b)}`}
              </span>
            </CLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TodoGroup({ todos }: { todos: readonly CalendarTodoItem[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <GroupHeader
        marker={
          <ListTodo
            aria-hidden="true"
            className="size-3 flex-shrink-0 text-ink-2"
          />
        }
        label="Todos"
        count={todos.length}
      />
      <ul aria-label="Todos" className="m-0 flex list-none flex-col gap-3 p-0">
        {/* The list is one day, so rows leave out the due date. */}
        {todos.map((item) =>
          item.kind === "todo" ? (
            <TodoRow
              key={`todo:${item.page_path}:${item.span_start}`}
              todo={{ ...item, due: null }}
            />
          ) : (
            <TaskRow
              key={`task:${item.id}`}
              task={{ ...item, due: null }}
              stacked
            />
          ),
        )}
      </ul>
    </div>
  );
}

function longDate(key: DateKey): string {
  return parseLocalDate(key).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** One day's birthdays, todos and pages (grouped by kind), plus the day's
 *  journal action. */
export function DayNotesList({
  dateKey,
  entries,
  birthdays = NO_BIRTHDAYS,
  todos = NO_TODOS,
  journalPath,
  today,
  loading = false,
  onOpenJournal,
  headingLevel = 3,
  className,
}: DayNotesListProps) {
  const Heading = `h${headingLevel}` as const;
  const groups = groupByKind(entries);
  const isToday = dateKey === (today ?? localDateKey(new Date()));
  const journalLabel =
    journalPath || isToday ? "Open journal" : "Create journal";
  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)}>
      <Heading className="m-0 font-serif text-[20px] italic leading-tight text-ink">
        {longDate(dateKey)}
      </Heading>
      {loading ? (
        <p role="status" className="m-0 text-[13px] text-mute">
          Loading…
        </p>
      ) : groups.length === 0 &&
        birthdays.length === 0 &&
        todos.length === 0 ? (
        <p className="m-0 text-[13px] text-mute">Nothing created this day.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {birthdays.length > 0 && <BirthdayGroup birthdays={birthdays} />}
          {todos.length > 0 && <TodoGroup todos={todos} />}
          {groups.map(({ kind, entries: group }) => {
            const label = kindDisplayLabel(kind);
            return (
              <div key={kind} className="flex min-w-0 flex-col gap-2">
                <GroupHeader
                  marker={
                    <span
                      data-kind-dot
                      aria-hidden="true"
                      className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                      style={{ background: KIND_META[kind].color }}
                    />
                  }
                  label={label}
                  count={group.length}
                />
                <ul
                  aria-label={label}
                  className="m-0 flex list-none flex-col gap-2 p-0"
                >
                  {group.map((e) => (
                    <li key={e.path} className="min-w-0">
                      <CLink path={e.path} className={ROW_LINK}>
                        <KindIcon
                          kind={e.kind}
                          tone="mono"
                          className="flex-shrink-0"
                        />
                        <span className="truncate" title={e.path}>
                          {e.title || e.path}
                        </span>
                      </CLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      <div>
        <Button variant="secondary" size="sm" onPress={onOpenJournal}>
          <CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />
          {journalLabel}
        </Button>
      </div>
    </div>
  );
}
