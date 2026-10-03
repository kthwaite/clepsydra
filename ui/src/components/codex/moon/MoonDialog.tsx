import { useMemo, useState } from "react";
import { Dialog } from "#/components/ui/dialog";
import { formatDistanceKm, formatMoonTime, formatNextFull } from "../sky";
import type { CalendarMonth } from "./calendar";
import { LazyMoonGlobe } from "./LazyMoonGlobe";
import { MoonCalendar } from "./MoonCalendar";
import { MoonFace } from "./MoonFace";
import { type MoonLocation, moonAt } from "./moon";
import { MoonTimeline } from "./MoonTimeline";
import { formatMoonInstant } from "./timeline";

const GLOBE_PX = 280;

export interface MoonDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  now: Date;
  /** Moonrise and moonset need it; everything else is location-free. */
  location?: MoonLocation | null;
}

/** The Moon in detail: a live globe, a time scrubber, stats and a phase
 *  calendar, all driven by one scrubbed instant. */
export function MoonDialog({
  isOpen,
  onOpenChange,
  now,
  location,
}: MoonDialogProps) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} title="Moon" size="lg">
      {/* The body unmounts while closed, so each opening starts at now. */}
      <MoonDetail now={now} location={location ?? null} />
    </Dialog>
  );
}

function monthOf(date: Date): CalendarMonth {
  return { year: date.getFullYear(), monthIndex0: date.getMonth() };
}

/** `day`'s local date at `time`'s local time of day. */
function atTimeOf(day: Date, time: Date): Date {
  const next = new Date(day);
  next.setHours(
    time.getHours(),
    time.getMinutes(),
    time.getSeconds(),
    time.getMilliseconds(),
  );
  return next;
}

function MoonDetail({
  now,
  location,
}: {
  now: Date;
  location: MoonLocation | null;
}) {
  const [instant, setInstant] = useState(() => new Date(now.getTime()));
  const [month, setMonth] = useState(() => monthOf(now));
  const moon = useMemo(() => moonAt(instant, location), [instant, location]);

  // The grid follows the instant across a month boundary; paging the grid
  // by hand moves only the grid.
  const changeInstant = (next: Date) => {
    const from = monthOf(instant);
    const to = monthOf(next);
    if (from.year !== to.year || from.monthIndex0 !== to.monthIndex0) {
      setMonth(to);
    }
    setInstant(next);
  };

  return (
    <div className="flex flex-col gap-6 pb-4">
      <div className="flex justify-center pt-1">
        <LazyMoonGlobe
          date={instant}
          size={GLOBE_PX}
          fallback={<MoonFace date={instant} size={GLOBE_PX} />}
        />
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <h3 className="m-0 font-serif text-[26px] leading-tight text-ink">
          {moon.phaseName}
        </h3>
        <p className="m-0 text-[14px] text-ink-2 tabular-nums">
          {formatMoonInstant(instant)}
        </p>
      </div>

      <MoonTimeline value={instant} now={now} onChange={changeInstant} />

      <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2.5 text-[14px]">
        <Stat k="Illumination" v={`${moon.illumPct}%`} />
        <Stat k="Moonrise" v={formatMoonTime(moon.rise)} />
        <Stat k="Moonset" v={formatMoonTime(moon.set)} />
        <Stat k="Next full moon" v={formatNextFull(instant, moon.nextFull)} />
        <Stat k="Next new moon" v={formatNextFull(instant, moon.nextNew)} />
        <Stat k="Distance" v={formatDistanceKm(moon.distanceKm)} />
      </dl>

      <MoonCalendar
        month={month}
        onMonthChange={setMonth}
        selected={instant}
        today={now}
        onSelectDay={(day) => changeInstant(atTimeOf(day, instant))}
      />
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-mute">{k}</dt>
      <dd className="m-0 text-right text-ink tabular-nums">{v}</dd>
    </>
  );
}
