import type { CellValue } from "./cells/types";

/**
 * Strip `[[Target|display]]` down to `Target`.
 *
 * Relation cells hold wikilink syntax, but the server's `links_to` normalises
 * a target without stripping brackets — so anything that filters or edits a
 * relation value has to unwrap it first. Non-strings have no target.
 */
export function wikilinkTarget(value: CellValue): string {
  if (typeof value !== "string") return "";
  const inner = value.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  return inner.split("|")[0] ?? inner;
}
