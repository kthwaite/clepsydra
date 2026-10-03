/** Pure helpers for the moon timeline scrubber. */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** The strip shows this many hours either side of the scrubbed instant. */
export const TIMELINE_SPAN_HOURS = 72;
/**
 * The slider's reachable range either side of now. Wide, so any day the
 * calendar pages to stays inside the slider's bounds.
 */
export const SCRUB_RANGE_DAYS = 100 * 366;

export interface TimelineTick {
  time: Date;
  /** Horizontal offset from the centre marker, in px. */
  offsetPx: number;
  /** "day" ticks fall at local midnight and are drawn taller. */
  kind: "hour" | "day";
}

export interface TimelineLabel {
  /** Local noon of the labelled day. */
  time: Date;
  offsetPx: number;
  text: string;
  today: boolean;
}

function offsetOf(time: Date, value: Date, pxPerHour: number): number {
  return ((time.getTime() - value.getTime()) / HOUR_MS) * pxPerHour;
}

/** Hourly ticks within ±spanHours of `value`, on local hour boundaries. */
export function timelineTicks(
  value: Date,
  pxPerHour: number,
  spanHours = TIMELINE_SPAN_HOURS,
): TimelineTick[] {
  const first = new Date(value.getTime() - spanHours * HOUR_MS);
  first.setMinutes(0, 0, 0);
  if (first.getTime() < value.getTime() - spanHours * HOUR_MS) {
    first.setTime(first.getTime() + HOUR_MS);
  }
  const last = value.getTime() + spanHours * HOUR_MS;
  const ticks: TimelineTick[] = [];
  for (let t = first.getTime(); t <= last; t += HOUR_MS) {
    const time = new Date(t);
    ticks.push({
      time,
      offsetPx: offsetOf(time, value, pxPerHour),
      kind: time.getHours() === 0 ? "day" : "hour",
    });
  }
  return ticks;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "Today" for the day containing `now`, else the short weekday ("Fri"). */
export function dayLabel(day: Date, now: Date): string {
  if (sameLocalDay(day, now)) return "Today";
  return day.toLocaleDateString("en-GB", { weekday: "short" });
}

/** One label per local day, centred at its noon, within ±spanHours. */
export function timelineLabels(
  value: Date,
  now: Date,
  pxPerHour: number,
  spanHours = TIMELINE_SPAN_HOURS,
): TimelineLabel[] {
  const labels: TimelineLabel[] = [];
  const start = new Date(value.getTime() - spanHours * HOUR_MS);
  const end = value.getTime() + spanHours * HOUR_MS;
  for (
    let noon = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      12,
    );
    noon.getTime() <= end;
    noon = new Date(noon.getFullYear(), noon.getMonth(), noon.getDate() + 1, 12)
  ) {
    if (noon.getTime() < start.getTime()) continue;
    labels.push({
      time: noon,
      offsetPx: offsetOf(noon, value, pxPerHour),
      text: dayLabel(noon, now),
      today: sameLocalDay(noon, now),
    });
  }
  return labels;
}

/** "Saturday 3 October at 13:00" (en-GB, 24-hour). */
export function formatMoonInstant(date: Date): string {
  const day = date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${day} at ${time}`;
}

/** The slider's bounds: now ± SCRUB_RANGE_DAYS. */
export function scrubBounds(now: Date): { min: number; max: number } {
  return {
    min: now.getTime() - SCRUB_RANGE_DAYS * DAY_MS,
    max: now.getTime() + SCRUB_RANGE_DAYS * DAY_MS,
  };
}

export function clampToBounds(ms: number, now: Date): Date {
  const { min, max } = scrubBounds(now);
  return new Date(Math.min(max, Math.max(min, ms)));
}

/** The instant a scrubber key moves to, or null for keys it ignores.
 *  ←/→ ±1 h; Shift+←/→ and PageUp/PageDown ±1 day; Home → now. */
export function keyStep(
  key: string,
  shiftKey: boolean,
  value: Date,
  now: Date,
): Date | null {
  const v = value.getTime();
  switch (key) {
    case "ArrowLeft":
      return clampToBounds(v - (shiftKey ? DAY_MS : HOUR_MS), now);
    case "ArrowRight":
      return clampToBounds(v + (shiftKey ? DAY_MS : HOUR_MS), now);
    case "PageDown":
      return clampToBounds(v - DAY_MS, now);
    case "PageUp":
      return clampToBounds(v + DAY_MS, now);
    case "Home":
      return new Date(now.getTime());
    default:
      return null;
  }
}

/** The instant reached by dragging `dxPx` from `start`: dragging the strip
 *  right moves the marker back in time. */
export function dragTo(
  start: Date,
  dxPx: number,
  pxPerHour: number,
  now: Date,
): Date {
  return clampToBounds(start.getTime() - (dxPx / pxPerHour) * HOUR_MS, now);
}

/** Rounds to the nearest whole local hour. */
export function snapToHour(date: Date): Date {
  const snapped = new Date(date.getTime() + HOUR_MS / 2);
  snapped.setMinutes(0, 0, 0);
  return snapped;
}
