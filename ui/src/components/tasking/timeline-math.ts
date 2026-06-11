/**
 * timeline-math.ts — pure date/position helpers for TimelineView.
 *
 * Deviations from the prototype (board-modes.jsx tlParse / TL_WIN_*):
 *   - parseDay: ISO YYYY-MM-DD only (no MM.DD display string support).
 *     The API exclusively serves ISO dates; the prototype's MM.DD branch
 *     handled display strings that our typed API never produces.
 *   - windowOf: derived from cycle dates (decision 14) rather than hardcoded
 *     constants.  Returns min(cycle.start) − 2 days … max(cycle.end) + 2 days.
 *   - pct: accepts an explicit window object; clamped 0–100.
 *     When the window is degenerate (start === end) pct returns 0 rather than
 *     dividing by zero.
 */

import type { BoardCycle, BoardTask } from "#/api/board";

export interface TLWindow {
  start: number; // ms epoch
  end: number; // ms epoch
}

const DAY_MS = 864e5; // 24 * 60 * 60 * 1000

/**
 * Parse an ISO YYYY-MM-DD string to a local-midnight ms epoch.
 * Returns null for any other format or falsy input.
 *
 * NOTE: "YYYY-MM-DDTHH:MM:SS" strings are not supported — pass only
 * bare date strings.  The prototype also parsed "MM.DD" display strings;
 * we do not because the API only serves ISO dates.
 */
export function parseDay(s: string | null | undefined): number | null {
  if (!s) return null;
  // Must match YYYY-MM-DD exactly (10 chars, '-' separators)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

/**
 * Derive the timeline display window from a set of cycles.
 * Returns { start, end } = min(cycle.start) − 2 days … max(cycle.end) + 2 days.
 * Returns null when no cycle carries a valid start or end date.
 *
 * Decision 14: the window is always derived, never hardcoded.
 */
export function windowOf(cycles: BoardCycle[]): TLWindow | null {
  let minStart: number | null = null;
  let maxEnd: number | null = null;

  for (const c of cycles) {
    const s = parseDay(c.start);
    const e = parseDay(c.end);
    if (s !== null) minStart = minStart === null ? s : Math.min(minStart, s);
    if (e !== null) maxEnd = maxEnd === null ? e : Math.max(maxEnd, e);
  }

  if (minStart === null && maxEnd === null) return null;

  // Use whichever bound we have; fall back to the other bound ±2d
  const start = (minStart ?? maxEnd!) - 2 * DAY_MS;
  const end = (maxEnd ?? minStart!) + 2 * DAY_MS;

  return { start, end };
}

/**
 * Map a ms epoch to a clamped 0–100 percentage position within the window.
 *
 * Degenerate window (start === end): returns 0 to avoid division by zero.
 */
export function pct(ms: number, win: TLWindow): number {
  if (win.end === win.start) return 0;
  const p = (ms - win.start) / (win.end - win.start);
  return Math.max(0, Math.min(1, p)) * 100;
}

export interface TLTaskRange {
  s: number; // start ms epoch
  e: number; // end ms epoch
}

/**
 * Compute the left/right ms bounds for a task's gantt bar.
 *
 * Rules:
 *   - e = parseDay(t.due); null when no due → unscheduled → return null.
 *   - s = parseDay(t.start) if set; else e − 2 days.
 *
 * Returns null when the task has no due date (unscheduled).
 */
export function taskRange(t: BoardTask): TLTaskRange | null {
  const e = parseDay(t.due);
  if (e === null) return null;
  const s = parseDay(t.start) ?? e - 2 * DAY_MS;
  return { s, e };
}
