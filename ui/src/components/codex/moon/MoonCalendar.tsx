import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { Group, ToggleButton } from "react-aria-components";
import { IconButton } from "#/components/ui/icon-button";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";
import {
  type CalendarMonth,
  dayPhaseName,
  EVENT_NAMES,
  formatDayLong,
  formatEventDate,
  formatMonthTitle,
  monthGrid,
  sameLocalDay,
  shiftMonth,
} from "./calendar";
import { monthPhases } from "./moon";
import { PhaseGlyph } from "./PhaseGlyph";

export interface MoonCalendarProps {
  month: CalendarMonth;
  onMonthChange: (month: CalendarMonth) => void;
  selected: Date;
  today: Date;
  onSelectDay: (date: Date) => void;
  className?: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A Monday-first month grid with each day's phase, then the month's
 *  quarter events. */
export function MoonCalendar({
  month,
  onMonthChange,
  selected,
  today,
  onSelectDay,
  className,
}: MoonCalendarProps) {
  const { year, monthIndex0 } = month;
  const phases = useMemo(
    () => monthPhases(year, monthIndex0),
    [year, monthIndex0],
  );
  const cells = monthGrid(year, monthIndex0);
  const title = formatMonthTitle(month);
  const events = [...phases.events].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between">
        <h3 className="m-0 font-serif text-[22px] leading-tight text-ink">
          {title}
        </h3>
        <div className="flex items-center gap-1">
          <IconButton
            aria-label="Previous month"
            onPress={() => onMonthChange(shiftMonth(month, -1))}
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            aria-label="Next month"
            onPress={() => onMonthChange(shiftMonth(month, 1))}
          >
            <ChevronRight />
          </IconButton>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((w) => (
          <span
            key={w}
            aria-hidden
            className="pb-1 text-center text-[12.5px] text-mute"
          >
            {w}
          </span>
        ))}
      </div>
      <Group aria-label={title} className="grid grid-cols-7 gap-1">
        {cells.map((n, i) => {
          if (n === null) {
            // biome-ignore lint/suspicious/noArrayIndexKey: leading blanks are positional
            return <span key={`blank-${i}`} aria-hidden />;
          }
          const day = phases.days[n - 1];
          const isToday = sameLocalDay(day.date, today);
          const isSelected = sameLocalDay(day.date, selected);
          return (
            <ToggleButton
              key={n}
              isSelected={isSelected}
              onChange={() => onSelectDay(day.date)}
              aria-label={`${formatDayLong(day.date)}, ${dayPhaseName(day, phases.events)}`}
              className={cn(
                "flex cursor-pointer flex-col items-center gap-1 rounded-[12px] py-1.5 text-[14px] tabular-nums transition-colors data-[hovered]:bg-sink",
                isSelected && "bg-accent-tint data-[hovered]:bg-accent-tint",
                isToday ? "font-medium text-accent" : "text-ink",
                FOCUS_RING,
              )}
            >
              <span>{n}</span>
              <PhaseGlyph
                illumFraction={day.illumFraction}
                waxing={day.waxing}
              />
            </ToggleButton>
          );
        })}
      </Group>
      <dl className="m-0 flex flex-col gap-1.5 pt-1">
        {events.map((e) => (
          <div
            key={`${e.kind}-${e.date.getTime()}`}
            className="flex items-baseline justify-between gap-4 text-[14px]"
          >
            <dt className="text-ink">{EVENT_NAMES[e.kind]}</dt>
            <dd className="m-0 text-mute tabular-nums">
              {formatEventDate(e.date)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
