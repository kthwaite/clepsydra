// Client-side mirror of the `occurred_at` field MEETING pages carry
// (src/vault/meeting.rs). The backend re-checks every write; this exists so
// the rail knows which kinds show the field and what "now" looks like.
//
// A 1:1 is a MEETING carrying the user tag `1:1` (ADR 0006); the helpers at
// the bottom keep that spelling in one place.

import type { Kind } from "#/lib/kind";
import { pad2 } from "#/lib/time";

/** The frontmatter key holding the occurrence time. */
export const OCCURRED_AT_KEY = "occurred_at";

/** Whether pages of this kind record when they took place. */
export const recordsOccurrence = (kind: Kind): boolean => kind === "MEETING";

/** The tag that marks a MEETING as a 1:1. Exact spelling. */
export const ONE_ON_ONE_TAG = "1:1";

/** Whether a tag list marks its page as a 1:1. */
export const isOneOnOne = (tags: readonly string[]): boolean =>
  tags.includes(ONE_ON_ONE_TAG);

/** The tag list with the 1:1 tag appended once (`on`) or removed (`off`).
 * Always returns a new array. */
export function withOneOnOne(tags: readonly string[], on: boolean): string[] {
  const without = tags.filter((tag) => tag !== ONE_ON_ONE_TAG);
  return on ? [...without, ONE_ON_ONE_TAG] : without;
}

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

/** The stored value as a string, or null when absent or unreadable.
 *
 * A hand-edited page can hold anything; a non-string is left to `clep doctor`
 * to report rather than rendered as `[object Object]`. */
export function readOccurredAt(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
