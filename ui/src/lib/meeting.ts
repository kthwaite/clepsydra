// Client-side mirror of the `occurred_at` field MEETING pages carry
// (crates/clep-vault/src/meeting.rs). The backend re-checks every write; this exists so
// the rail knows which kinds show the field and what "now" looks like.

import type { Kind } from "#/lib/kind";
import { pad2 } from "#/lib/time";

/** The frontmatter key holding the occurrence time. */
export const OCCURRED_AT_KEY = "occurred_at";

/** Whether pages of this kind record when they took place. */
export const recordsOccurrence = (kind: Kind): boolean => kind === "MEETING";

/**
 * `YYYY-MM-DDTHH:MM:SS` in the viewer's own zone — the shape
 * `<input type="datetime-local">` produces, and a TOML local date-time on the
 * way in. Meetings are remembered in the local wall clock they happened on,
 * so no offset is attached.
 */
export function localIso(date: Date): string {
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return `${day}T${time}`;
}

/** The quarter hour that has already started, as a new Date: 12:00 stays
 * 12:00, 12:01 and 12:14 become 12:00, 12:16 becomes 12:15. Seconds and
 * milliseconds are dropped.
 *
 * "Now" on a meeting means the slot it was booked in, not the instant the
 * button was pressed — nobody records a meeting as having started at 12:16:41.
 * `localIso` still writes the `:00` seconds, which a TOML date-time requires. */
export function floorToQuarterHour(date: Date): Date {
  const floored = new Date(date);
  floored.setMinutes(Math.floor(date.getMinutes() / 15) * 15, 0, 0);
  return floored;
}

/** The stored value as a string, or null when absent or unreadable.
 *
 * A hand-edited page can hold anything; a non-string is left to `clep doctor`
 * to report rather than rendered as `[object Object]`. */
export function readOccurredAt(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
