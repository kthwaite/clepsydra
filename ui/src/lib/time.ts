// Shared time helpers: zero-padding, clocks, local "YYYY-MM-DD" calendar
// dates, calendar math, and human-readable relative/absolute formatting.

const MS_PER_DAY = 86_400_000;

/** Zero-pad a number to two digits. */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local calendar date as a "YYYY-MM-DD" key. */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Parse "YYYY-MM-DD" into a local-midnight Date. Splitting avoids the UTC
 * interpretation (and timezone day-shift) of `new Date("YYYY-MM-DD")`.
 */
export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "YYYY-MM-DD" + days → "YYYY-MM-DD", in local calendar days. */
export function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return localDateKey(new Date(y, m - 1, d + days));
}

/** 1-based day of the local calendar year (DST-safe). */
export function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getFullYear(), 0, 0);
  const day = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day - start) / MS_PER_DAY);
}

/** Gregorian leap-year test. */
export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Julian Day Number of a Date's UTC calendar day. */
export function julianDay(d: Date): number {
  const a = Math.floor((14 - (d.getUTCMonth() + 1)) / 12);
  const y = d.getUTCFullYear() + 4800 - a;
  const m = d.getUTCMonth() + 1 + 12 * a - 3;
  return (
    d.getUTCDate() +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

/** "HH:MM:SS" wall clock; UTC when `utc` is set, local otherwise. */
export function formatClock(d: Date, utc = false): string {
  return utc
    ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
    : `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** "HH:MM" local time of day. */
export function formatTimeHM(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Duration as "Xh YYm". */
export function formatDurationHM(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h ${pad2(m)}m`;
}

/** Compact "time since" for telemetry rows: "just now", "5m ago", "3mo ago". */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w ago`;
  return `${Math.floor(diff / (86400 * 30))}mo ago`;
}

/** Long local date ("28 April 2026" in en-GB) or an em-dash. */
export function formatAbsoluteDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Long local calendar day for a feed entry, or “Unknown date”. */
export function formatFeedDay(iso: string | null | undefined): string {
  if (!iso) return "Unknown date";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Compact local publication time for chronological feed rows. */
export function formatFeedTime(iso: string | null | undefined): string {
  if (!iso) return "Time unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Time unknown";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Stable timestamp/id boundary accepted by the bounded mark-read endpoint. */
export function feedEntryBoundary(iso: string, id: number): string {
  return `${iso}|${id}`;
}
