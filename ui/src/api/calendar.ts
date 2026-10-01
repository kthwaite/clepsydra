import { keepPreviousData } from "@tanstack/react-query";
import type { components } from "#/api/schema";
import { type LocalRange, toOffsetIso } from "#/lib/calendar/dates";
import type { Kind } from "#/lib/kind";
import { $api } from "./client";

export type CalendarEntry = components["schemas"]["CalendarEntry"];
export type CalendarResponse = components["schemas"]["CalendarResponse"];
export type CalendarBirthday = components["schemas"]["CalendarBirthday"];

/** An older server omits `birthdays`; read that as none. */
function withBirthdays(data: CalendarResponse): CalendarResponse {
  return data.birthdays ? data : { ...data, birthdays: [] };
}

export interface CalendarEntriesOptions {
  range: LocalRange;
  kinds?: readonly Kind[];
  tag?: string;
  project?: string;
}

/**
 * Pages placed on calendar days in `range`. The bounds go out as local
 * midnights with their offsets; the server stays timezone-agnostic and the
 * client buckets. The key lives under `/api/vault/index`, so every page
 * mutation and SSE event already invalidates it. `birthdays` lists PERSON
 * birthdays (yearly, not windowed); the server empties it when `kinds`
 * excludes PERSON.
 */
export function useCalendarEntries(
  opts: CalendarEntriesOptions,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { range, kinds, tag, project } = opts;
  return $api.useQuery(
    "get",
    "/api/vault/index/calendar",
    {
      params: {
        query: {
          from: toOffsetIso(range.from),
          to: toOffsetIso(range.to),
          kind: kinds?.length ? [...kinds].sort().join(",") : undefined,
          tag,
          project,
        },
      },
    },
    { enabled, placeholderData: keepPreviousData, select: withBirthdays },
  );
}
