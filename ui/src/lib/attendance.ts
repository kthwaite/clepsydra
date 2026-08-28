// Client-side mirror of the `attendees` relation MEETING pages carry
// (src/vault/attendance.rs). The backend stays authoritative — it re-checks
// every write — so this exists to render the rail. A meeting names any number
// of people; a 1:1 is a MEETING tagged `1:1`, with no cardinality of its own.

import type { Kind } from "#/lib/kind";

/** The frontmatter key holding the relation. */
export const ATTENDEES_KEY = "attendees";

/** Whether this kind names attendees at all. */
export const hasAttendees = (kind: Kind): boolean => kind === "MEETING";

/** Strip wikilink brackets and any `|display` alias, mirroring
 * `extract_property_refs` in src/vault/link.rs. */
export function attendeeTarget(raw: string): string {
  const trimmed = raw.trim();
  const inner =
    trimmed.startsWith("[[") && trimmed.endsWith("]]")
      ? trimmed.slice(2, -2)
      : trimmed;
  const pipe = inner.indexOf("|");
  return (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
}

/** Wrap a bare name as a wikilink; an already-linked name is left alone. */
export function asWikilink(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("[[") && trimmed.endsWith("]]")
    ? trimmed
    : `[[${trimmed}]]`;
}

/** Read attendees off a page's frontmatter value, which the server writes as
 * an array but a hand-edited page may carry as a single string. Entries that
 * are not strings, or that name nobody, are dropped rather than rendered —
 * `clep doctor` is where malformed lists get reported. */
export function readAttendees(value: unknown): string[] {
  const raw =
    typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map(attendeeTarget)
    .filter((target) => target.length > 0);
}
