/** Conversion between a recipe textarea's text and its item list.
 *
 * The edit view is a plain textarea so a block of ingredients or steps can be
 * pasted straight from a web page. Whatever list marker came with that paste is
 * stripped here rather than being stored as part of the item — the codec owns
 * markers, items are opaque text. */

/** A leading unordered bullet or ordered marker, as pasted from elsewhere.
 * Requires trailing whitespace so a quantity like `1/2 tsp` is never mistaken
 * for a numbered item. */
const LEADING_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+/u;

const normalizeLineEndings = (value: string): string =>
  value.replace(/\r\n?/g, "\n");

export function itemsFromText(text: string): string[] {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => line.replace(LEADING_MARKER, "").trim())
    .filter((line) => line.length > 0);
}

export function textFromItems(items: string[]): string {
  return items.join("\n");
}
