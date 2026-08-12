import { createEditor } from "slate";
import { describe, expect, it } from "vitest";
import { baseEmbedDescriptor, makeBaseEmbed } from "../elements/baseEmbed";
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
  "image",
]);
const VOID = new Set<ElementType>([
  "wikilink",
  "block-ref",
  "inline-math",
  "footnote-ref",
  "thematic-break",
  "journal-time",
  "math-block",
  "image",
  "base-embed",
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
  "image",
  "base-embed",
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
    expect(editor.isInline(makeInlineMath({ tex: "x", delimiter: "$" }))).toBe(
      true,
    );
    expect(editor.isVoid(makeInlineMath({ tex: "x", delimiter: "$" }))).toBe(
      true,
    );
    expect(editor.isInline(makeMathBlock({ tex: "x", delimiter: "$$" }))).toBe(
      false,
    );
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

  it("registers Base embeds as void blocks and creates every discriminated state", () => {
    const unconfigured = makeBaseEmbed();
    const configured = makeBaseEmbed({
      status: "configured",
      base: "books",
      view: "Reading",
      sort: [],
      limit: 20,
    });
    const invalid = makeBaseEmbed({
      status: "invalid",
      rawBlock: "```base\nbad\n```\n",
      parseError: "bad TOML",
    });

    expect(baseEmbedDescriptor.kind).toBe("void-block");
    expect(unconfigured).toEqual({
      type: "base-embed",
      status: "unconfigured",
      children: [{ text: "" }],
    });
    expect(configured).toEqual({
      type: "base-embed",
      status: "configured",
      base: "books",
      view: "Reading",
      sort: [],
      limit: 20,
      children: [{ text: "" }],
    });
    expect(invalid).toEqual({
      type: "base-embed",
      status: "invalid",
      rawBlock: "```base\nbad\n```\n",
      parseError: "bad TOML",
      children: [{ text: "" }],
    });
    expect(editor.isInline(unconfigured)).toBe(false);
    expect(editor.isVoid(unconfigured)).toBe(true);
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
