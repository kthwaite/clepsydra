// Pure calendar date math. Every key is a local "YYYY-MM-DD"; every Date is
// local midnight. Day stepping uses UTC arithmetic on Y/M/D components, so
// DST days never shift a key.

import { localDateKey, pad2 } from "#/lib/time";

export type DateKey = string;

export interface IsoWeek {
  isoYear: number;
  week: number;
}

export interface WeekRow {
  isoYear: number;
  week: number;
  /** Seven keys, Monday..Sunday. */
  days: DateKey[];
}

/** Local range; `to` is exclusive. */
export interface LocalRange {
  from: Date;
  to: Date;
}

export type CalendarMode = "month" | "months" | "weeks";

const MS_PER_DAY = 86_400_000;

function parts(key: DateKey): [number, number, number] {
  const [y, m, d] = key.split("-").map(Number);
  return [y, m - 1, d];
}

function utcOf(key: DateKey): number {
  const [y, m, d] = parts(key);
  return Date.UTC(y, m, d);
}

function keyOfUtc(ms: number): DateKey {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function addDays(key: DateKey, n: number): DateKey {
  return keyOfUtc(utcOf(key) + n * MS_PER_DAY);
}

function localMidnight(key: DateKey): Date {
  const [y, m, d] = parts(key);
  return new Date(y, m, d);
}

/** 0 = Monday .. 6 = Sunday. */
function isoWeekday(key: DateKey): number {
  return (new Date(utcOf(key)).getUTCDay() + 6) % 7;
}

export function isoWeek(key: DateKey): IsoWeek {
  // The ISO week belongs to the year holding its Thursday.
  const thursday = utcOf(key) + (3 - isoWeekday(key)) * MS_PER_DAY;
  const isoYear = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((thursday - jan1) / MS_PER_DAY / 7) + 1;
  return { isoYear, week };
}

export function mondayOf(key: DateKey): DateKey {
  return addDays(key, -isoWeekday(key));
}

function rowAt(monday: DateKey): WeekRow {
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return { ...isoWeek(monday), days };
}

function monthKey(year: number, month0: number, day = 1): DateKey {
  return keyOfUtc(Date.UTC(year, month0, day));
}

/** Monday-start rows that touch the month. */
export function monthGrid(year: number, month0: number): WeekRow[] {
  const first = monthKey(year, month0);
  const last = monthKey(year, month0 + 1, 0);
  const rows: WeekRow[] = [];
  for (let monday = mondayOf(first); monday <= last; ) {
    rows.push(rowAt(monday));
    monday = addDays(monday, 7);
  }
  return rows;
}

/** `count` rows starting from `mondayOf(anchor)`. */
export function weekRows(anchor: DateKey, count: number): WeekRow[] {
  const start = mondayOf(anchor);
  return Array.from({ length: count }, (_, i) => rowAt(addDays(start, i * 7)));
}

/** Adds `n` months, clamping the day to the target month's length. */
export function addMonths(key: DateKey, n: number): DateKey {
  const [y, m, d] = parts(key);
  const lastDay = new Date(Date.UTC(y, m + n + 1, 0)).getUTCDate();
  return monthKey(y, m + n, Math.min(d, lastDay));
}

function gridSpan(year: number, month0: number): [DateKey, DateKey] {
  const rows = monthGrid(year, month0);
  return [rows[0].days[0], addDays(rows[rows.length - 1].days[6], 1)];
}

export function monthGridRange(year: number, month0: number): LocalRange {
  const [from, to] = gridSpan(year, month0);
  return { from: localMidnight(from), to: localMidnight(to) };
}

/** From the grid start of the anchor's month to the grid end of the month `months - 1` later. */
export function monthsRange(anchor: DateKey, months: number): LocalRange {
  const [y, m] = parts(anchor);
  const [from] = gridSpan(y, m);
  const [, to] = gridSpan(y, m + Math.max(1, months) - 1);
  return { from: localMidnight(from), to: localMidnight(to) };
}

export function rangeForView(v: {
  mode: CalendarMode;
  anchor: DateKey;
  span: number;
}): LocalRange {
  if (v.mode === "weeks") {
    const start = mondayOf(v.anchor);
    return {
      from: localMidnight(start),
      to: localMidnight(addDays(start, v.span * 7)),
    };
  }
  if (v.mode === "months") return monthsRange(v.anchor, v.span);
  const [y, m] = parts(v.anchor);
  return monthGridRange(y, m);
}

/** RFC3339 local time with its UTC offset, e.g. "2026-03-30T00:00:00+01:00". */
export function toOffsetIso(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${localDateKey(d)}T${time}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Inclusive first and last local keys of a range. */
export function rangeKeys(r: LocalRange): { first: DateKey; last: DateKey } {
  return {
    first: localDateKey(r.from),
    last: addDays(localDateKey(r.to), -1),
  };
}
