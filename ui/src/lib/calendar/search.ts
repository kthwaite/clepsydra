// URL search parsing for the Calendar screen: the view fields (mode, anchor
// date, span, selected day) plus the kind/tag/project filters.

import type { CalendarMode, DateKey } from "#/lib/calendar/dates";
import type { FilterState } from "#/lib/filters/model";
import {
  canonicalizeFilterSearch,
  type FilterUrlOptions,
  parseFilterSearch,
} from "#/lib/filters/url";
import { KINDS } from "#/lib/kind";

export const CALENDAR_FILTER_URL: FilterUrlOptions = {
  fields: [
    { id: "kind", kind: "multi", normalize: (v) => v.toUpperCase() },
    { id: "tag", kind: "single" },
    { id: "project", kind: "single" },
  ],
};

export interface CalendarViewSearch {
  mode: CalendarMode;
  date?: DateKey;
  span: number;
  day?: DateKey;
}

export const SPANS: Record<CalendarMode, readonly number[]> = {
  month: [1],
  months: [3, 6, 12],
  weeks: [1, 2, 4],
};

export const DEFAULT_SPAN: Record<CalendarMode, number> = {
  month: 1,
  months: 3,
  weeks: 2,
};

const KIND_SET = new Set<string>(KINDS);
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseMode(raw: unknown): CalendarMode {
  return raw === "months" || raw === "weeks" ? raw : "month";
}

function parseSpan(raw: unknown, mode: CalendarMode): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && SPANS[mode].includes(n)
    ? n
    : DEFAULT_SPAN[mode];
}

/** A strict "YYYY-MM-DD" that names a real calendar day. */
function parseDateKey(raw: unknown): DateKey | undefined {
  if (typeof raw !== "string") return undefined;
  const m = DATE_KEY.exec(raw);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  const roundTrips =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d;
  return roundTrips ? raw : undefined;
}

export function parseCalendarView(
  search: Record<string, unknown>,
): CalendarViewSearch {
  const mode = parseMode(search.mode);
  const view: CalendarViewSearch = {
    mode,
    span: parseSpan(search.span, mode),
  };
  const date = parseDateKey(search.date);
  const day = parseDateKey(search.day);
  if (date) view.date = date;
  if (day) view.day = day;
  return view;
}

/** `parseFilterSearch` with unknown kinds dropped. */
export function parseCalendarFilters(
  search: Record<string, unknown>,
): FilterState {
  const state = parseFilterSearch(search, CALENDAR_FILTER_URL);
  const kinds = state.facets.kind?.filter((k) => KIND_SET.has(k)) ?? [];
  const { kind: _dropped, ...rest } = state.facets;
  return {
    ...state,
    facets: kinds.length > 0 ? { ...rest, kind: kinds } : rest,
  };
}

/** The URL form of a view: the default mode and each mode's default span
 *  are omitted, so the bare `/calendar` URL stays clean. */
export function calendarViewToSearch(view: CalendarViewSearch): {
  mode: CalendarMode | undefined;
  span: number | undefined;
  date: DateKey | undefined;
  day: DateKey | undefined;
} {
  return {
    mode: view.mode === "month" ? undefined : view.mode,
    span: view.span === DEFAULT_SPAN[view.mode] ? undefined : view.span,
    date: view.date,
    day: view.day,
  };
}

export function validateCalendarSearch(
  search: Record<string, unknown>,
): Record<string, unknown> {
  const canonical = canonicalizeFilterSearch(search, CALENDAR_FILTER_URL);
  const kinds = parseCalendarFilters(search).facets.kind;
  return {
    ...canonical,
    kind: kinds ? [...kinds] : undefined,
    ...calendarViewToSearch(parseCalendarView(search)),
  };
}
