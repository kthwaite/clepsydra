// PERSON birthdays: the frontmatter forms, and their yearly recurrence on
// the calendar. Stored forms: `birthday = 1983-05-12` (native TOML date) when
// the year is known, `birthday = "05-12"` when it is not. `"--05-12"` is
// accepted on read too.

import type { DateKey } from "#/lib/calendar/dates";
import { isLeapYear, pad2 } from "#/lib/time";

export const BIRTHDAY_KEY = "birthday";

/** A leap year, so a yearless Feb 29 stays pickable in a date input. */
const PICKER_YEAR = 2000;

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export type Birthday = { year: number | null; month: number; day: number };

/** One PERSON's birthday as the calendar endpoint sends it. */
export type BirthdayEntry = {
  path: string;
  title?: string | null;
  month: number;
  day: number;
  year?: number | null;
};

/** One birthday landing on one calendar day. */
export type BirthdayOccurrence = {
  path: string;
  title: string | null;
  date: DateKey;
  /** Years turned that day; null when the birth year is unknown or ≥ it. */
  age: number | null;
};

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const FULL = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAY = /^(?:--)?(\d{2})-(\d{2})$/;

/** Parse a stored `birthday` value. Anything else (numbers, date-times,
 *  impossible dates) is null: an invalid birthday is ignored, not an error. */
export function readBirthday(raw: unknown): Birthday | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  const full = FULL.exec(text);
  const monthDay = full ? null : MONTH_DAY.exec(text);
  if (!full && !monthDay) return null;
  const year = full ? Number(full[1]) : null;
  const month = Number(full ? full[2] : monthDay?.[1]);
  const day = Number(full ? full[3] : monthDay?.[2]);
  if (month < 1 || month > 12 || day < 1) return null;
  // Without a year, validate against a leap year so Feb 29 is allowed.
  if (day > daysIn(year ?? PICKER_YEAR, month)) return null;
  return { year, month, day };
}

/** The value and type hint that store `b` in its frontmatter form. */
export function birthdayValue(b: Birthday): { value: string; hint?: "date" } {
  const monthDay = `${pad2(b.month)}-${pad2(b.day)}`;
  if (b.year === null) return { value: monthDay };
  return { value: `${b.year}-${monthDay}`, hint: "date" };
}

/** A full date for a date input; year 2000 stands in for an unknown year. */
export function birthdayPickerValue(b: Birthday): DateKey {
  return `${b.year ?? PICKER_YEAR}-${pad2(b.month)}-${pad2(b.day)}`;
}

/** "12 May 1983", or "12 May" when the year is unknown. */
export function formatBirthday(b: Birthday): string {
  const dayMonth = `${b.day} ${SHORT_MONTHS[b.month - 1]}`;
  return b.year === null ? dayMonth : `${dayMonth} ${b.year}`;
}

/** Every day in `first..last` (inclusive) on which a birthday falls. The
 *  range may cross year boundaries, so one person can appear twice. Feb 29
 *  falls on Feb 28 in non-leap years. Days keep the input order. */
export function birthdayOccurrences(
  birthdays: readonly BirthdayEntry[],
  range: { first: DateKey; last: DateKey },
): Map<DateKey, BirthdayOccurrence[]> {
  const out = new Map<DateKey, BirthdayOccurrence[]>();
  const firstYear = Number(range.first.slice(0, 4));
  const lastYear = Number(range.last.slice(0, 4));
  for (let y = firstYear; y <= lastYear; y++) {
    for (const b of birthdays) {
      const day = b.month === 2 && b.day === 29 && !isLeapYear(y) ? 28 : b.day;
      const date = `${y}-${pad2(b.month)}-${pad2(day)}`;
      if (date < range.first || date > range.last) continue;
      const age = b.year == null ? null : y - b.year;
      const occurrence: BirthdayOccurrence = {
        path: b.path,
        title: b.title ?? null,
        date,
        age: age !== null && age > 0 ? age : null,
      };
      const list = out.get(date);
      if (list) list.push(occurrence);
      else out.set(date, [occurrence]);
    }
  }
  return out;
}

/** "birthday, turns 43", or just "birthday" when the age is unknown. The day
 *  list renders it after the person's title. */
export function birthdayLabel(o: BirthdayOccurrence): string {
  return o.age === null ? "birthday" : `birthday, turns ${o.age}`;
}
