import { createEditor } from "slate";
import { describe, expect, it } from "vitest";
import type { ElementType } from "../types";
import { withSchema } from "../withSchema";

const INLINE = new Set<ElementType>([
  "wikilink",
  "block-ref",
  "footnote-ref",
  "link",
]);
const VOID = new Set<ElementType>([
  "wikilink",
  "block-ref",
  "footnote-ref",
  "thematic-break",
]);

const ALL_TYPES: ElementType[] = [
  "paragraph",
  "heading",
  "code-block",
  "blockquote",
  "bulleted-list",
  "numbered-list",
  "list-item",
  "thematic-break",
  "wikilink",
  "link",
  "block-ref",
  "footnote-ref",
  "footnote-def",
];

describe("withSchema classification", () => {
  const editor = withSchema(createEditor());

  it.each(ALL_TYPES)("isInline(%s) matches legacy", (type) => {
    expect(editor.isInline({ type, children: [{ text: "" }] } as never)).toBe(
      INLINE.has(type),
    );
  });

  it.each(ALL_TYPES)("isVoid(%s) matches legacy", (type) => {
    expect(editor.isVoid({ type, children: [{ text: "" }] } as never)).toBe(
      VOID.has(type),
    );
  });
});
