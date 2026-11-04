/**
 * A blockquote or footnote definition with no content parses with no children.
 * The page loads the converter's value without normalizing it, so the converter
 * has to give these a line the caret can reach.
 */
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";

const emptyLine = { type: "paragraph", children: [{ text: "" }] };

describe("an empty blockquote", () => {
  it("loads with an empty paragraph", () => {
    expect(markdownToSlate(">\n")).toEqual([
      { type: "blockquote", children: [emptyLine] },
    ]);
  });

  it("saves back to the same Markdown", () => {
    expect(slateToMarkdown(markdownToSlate(">\n"))).toBe(">\n");
  });

  it("keeps a quote with content unchanged", () => {
    expect(markdownToSlate("> a\n")).toEqual([
      {
        type: "blockquote",
        children: [{ type: "paragraph", children: [{ text: "a" }] }],
      },
    ]);
  });
});

describe("an empty footnote definition", () => {
  it("loads the same as a definition the editor creates", () => {
    expect(markdownToSlate("a[^x]\n\n[^x]:\n")).toContainEqual({
      type: "footnote-def",
      identifier: "x",
      children: [{ text: "" }],
    });
  });

  it("saves back to the same Markdown", () => {
    const md = "a[^x]\n\n[^x]:\n";
    expect(slateToMarkdown(markdownToSlate(md))).toBe(md);
  });

  it("keeps a definition with content unchanged", () => {
    expect(markdownToSlate("a[^x]\n\n[^x]: note\n")).toContainEqual({
      type: "footnote-def",
      identifier: "x",
      children: [{ type: "paragraph", children: [{ text: "note" }] }],
    });
  });
});
