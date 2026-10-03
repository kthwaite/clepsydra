/** Pure helpers for the moon phase calendar. */
import { MOON_NAMES } from "#/components/codex/sky";
import type { MoonDay, MoonEvent, MoonEventKind } from "./moon";

export interface CalendarMonth {
  year: number;
  monthIndex0: number;
}

export const EVENT_NAMES: Record<MoonEventKind, string> = {
  new: "New moon",
  first: "First quarter",
  full: "Full moon",
  last: "Last quarter",
};

/** Day-of-month numbers in Monday-first week order, with null leading
 *  blanks before the 1st. */
export function monthGrid(
  year: number,
  monthIndex0: number,
): (number | null)[] {
  const lead = (new Date(year, monthIndex0, 1).getDay() + 6) % 7;
  const count = new Date(year, monthIndex0 + 1, 0).getDate();
  const cells: (number | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= count; d++) cells.push(d);
  return cells;
}

export function shiftMonth(month: CalendarMonth, delta: number): CalendarMonth {
  const d = new Date(month.year, month.monthIndex0 + delta, 1);
  return { year: d.getFullYear(), monthIndex0: d.getMonth() };
}

export function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** The day's phase name: a quarter event on that local day wins, else the
 *  eighth of the cycle the day's noon falls in. */
export function dayPhaseName(day: MoonDay, events: MoonEvent[]): string {
  const event = events.find((e) => sameLocalDay(e.date, day.date));
  if (event) return EVENT_NAMES[event.kind];
  const name = MOON_NAMES[Math.round(day.phase * 8) % 8];
  if (name === "New") return "New moon";
  if (name === "Full") return "Full moon";
  return name;
}

/** "Saturday 10 October". */
export function formatDayLong(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** "Sat 10 Oct". */
export function formatEventDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** "October 2026". */
export function formatMonthTitle(month: CalendarMonth): string {
  return new Date(month.year, month.monthIndex0, 1).toLocaleDateString(
    "en-GB",
    { month: "long", year: "numeric" },
  );
}

/** The lit region of a disc of radius r centred at (cx, cy), seen north-up:
 *  a semicircle on the lit side closed by the terminator, a half-ellipse
 *  with rx = r·|1 − 2f|. Lit on the right while waxing. Returns null when
 *  nothing is lit. */
export function phaseGlyphPath(
  illumFraction: number,
  waxing: boolean,
  r: number,
  cx = r,
  cy = r,
): string | null {
  const f = Math.min(1, Math.max(0, illumFraction));
  if (f <= 0.005) return null;
  const top = `${cx} ${cy - r}`;
  const bottom = `${cx} ${cy + r}`;
  if (f >= 0.995) {
    return `M ${top} A ${r} ${r} 0 0 1 ${bottom} A ${r} ${r} 0 0 1 ${top} Z`;
  }
  const rx = round(r * Math.abs(1 - 2 * f));
  const outer = waxing ? 1 : 0;
  const inner = f > 0.5 === waxing ? 1 : 0;
  return `M ${top} A ${r} ${r} 0 0 ${outer} ${bottom} A ${rx} ${r} 0 0 ${inner} ${top} Z`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
