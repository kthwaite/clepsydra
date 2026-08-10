import { createEditor } from "slate";
import { describe, expect, it } from "vitest";
import {
  inlineMathDescriptor,
  makeInlineMath,
  makeMathBlock,
  mathBlockDescriptor,
} from "../elements/math";
import type { ElementType } from "../types";
import { withSchema } from "../withSchema";

const INLINE = new Set<ElementType>([
  "wikilink",
  "inline-math",
  "block-ref",
  "footnote-ref",
  "link",
]);
const VOID = new Set<ElementType>([
  "wikilink",
  "block-ref",
  "inline-math",
  "footnote-ref",
  "thematic-break",
  "journal-time",
  "math-block",
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
  "inline-math",
  "link",
  "block-ref",
  "footnote-ref",
  "footnote-def",
  "journal-time",
  "math-block",
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

  it("classifies inline and display math as void elements", () => {
    expect(
      editor.isInline(makeInlineMath({ tex: "x", delimiter: "$" })),
    ).toBe(true);
    expect(editor.isVoid(makeInlineMath({ tex: "x", delimiter: "$" }))).toBe(
      true,
    );
    expect(
      editor.isInline(makeMathBlock({ tex: "x", delimiter: "$$" })),
    ).toBe(false);
    expect(editor.isVoid(makeMathBlock({ tex: "x", delimiter: "$$" }))).toBe(
      true,
    );
  });

  it("creates math voids with exactly one empty text child", () => {
    expect(makeInlineMath({ tex: "x", delimiter: "$" }).children).toEqual([
      { text: "" },
    ]);
    expect(makeMathBlock({ tex: "x", delimiter: "$$" }).children).toEqual([
      { text: "" },
    ]);
  });

  it("serializes math descriptors with authored delimiter metadata", () => {
    const inline = makeInlineMath({ tex: "x", delimiter: "\\(" });
    const display = makeMathBlock({ tex: "y", delimiter: "\\[" });

    expect(inlineMathDescriptor.toMdast?.(inline, {} as never)).toEqual({
      type: "inlineMath",
      value: "x",
      data: {
        folioDelimiter: "\\(",
        folioSourceBody: "x",
      },
    });
    expect(mathBlockDescriptor.toMdast?.(display, {} as never)).toEqual({
      type: "math",
      value: "y",
      data: {
        folioDelimiter: "\\[",
        folioSourceBody: "y",
      },
    });
  });
});
