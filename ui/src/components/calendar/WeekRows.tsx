import { CLink } from "#/components/codex/CLink";
import { Button } from "#/components/ui/button";
import type { CalendarEntryLike } from "#/lib/calendar/bucket";
import type { DateKey, WeekRow } from "#/lib/calendar/dates";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { KIND_META } from "#/lib/kind";
import { parseLocalDate } from "#/lib/time";

export interface WeekRowsProps {
  rows: readonly WeekRow[];
  byDay: ReadonlyMap<DateKey, readonly CalendarEntryLike[]>;
  today: DateKey;
  /** The day whose side panel is open. */
  activeDate?: DateKey | null;
  onDayActivate: (key: DateKey) => void;
}

/** Titles listed inline per day; the rest open through the day panel. */
const MAX_INLINE = 8;

const NO_ENTRIES: readonly CalendarEntryLike[] = [];

function dayLabel(key: DateKey, count: number): string {
  const date = parseLocalDate(key).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  if (count === 0) return date;
  return `${date}, ${count} ${count === 1 ? "page" : "pages"}`;
}

function DayColumn({
  dateKey,
  entries,
  isToday,
  isActive,
  showMonth,
  onDayActivate,
}: {
  dateKey: DateKey;
  entries: readonly CalendarEntryLike[];
  isToday: boolean;
  isActive: boolean;
  showMonth: boolean;
  onDayActivate: (key: DateKey) => void;
}) {
  const date = parseLocalDate(dateKey);
  const shown = entries.slice(0, MAX_INLINE);
  const hidden = entries.length - shown.length;
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
        aria-label={dayLabel(dateKey, entries.length)}
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
      {shown.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {shown.map((e) => (
            <li key={e.path} className="min-w-0">
              <CLink
                path={e.path}
                className={cn(
                  "cl-link-plain flex min-w-0 items-center gap-1.5 rounded text-[13px] text-ink-2 hover:text-ink",
                  FOCUS_RING_NATIVE,
                )}
              >
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

/** Weeks mode: one row per ISO week, each day listing its pages inline. */
export function WeekRows({
  rows,
  byDay,
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
