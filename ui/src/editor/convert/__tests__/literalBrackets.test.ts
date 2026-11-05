import type { Descendant } from "slate";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../index";

const paragraph = (text: string) =>
  ({ type: "paragraph", children: [{ text }] }) as Descendant;
const bullet = (text: string) =>
  ({
    type: "bulleted-list",
    children: [{ type: "list-item", children: [paragraph(text)] }],
  }) as Descendant;

const roundTrip = (doc: Descendant[]) => markdownToSlate(slateToMarkdown(doc));

describe("text that is wholly in square brackets", () => {
  const texts = [
    "[TODO]",
    "[a b]",
    "[x]",
    "[ ]",
    "[]",
    "[^1]",
    "[a] [b]",
    "[[a]]",
  ];

  it.each(texts)("%s stays text in a bullet", (text) => {
    const doc = [bullet(text)];

    expect(roundTrip(doc)).toEqual(doc);
  });

  it.each(texts)("%s stays text in a paragraph", (text) => {
    const doc = [paragraph(text)];

    expect(roundTrip(doc)).toEqual(doc);
  });

  it.each(["[TODO]", "[abc", "[note] text", "[ ]"])(
    "%s does not swallow the blocks after it",
    (text) => {
      const next = bullet("next");
      const doc = [paragraph(text), next, paragraph("after")];

      expect(roundTrip(doc)).toEqual(doc);
    },
  );

  it.each(["[TODO]", "[abc", "[ ]"])(
    "%s does not swallow a bullet's children or siblings",
    (text) => {
      const doc = [
        {
          type: "bulleted-list",
          children: [
            {
              type: "list-item",
              children: [paragraph(text), bullet("kid")],
            },
            { type: "list-item", children: [paragraph("sibling")] },
          ],
        } as Descendant,
      ];

      expect(roundTrip(doc)).toEqual(doc);
    },
  );

  it("handles a bracket starting a later line of the text", () => {
    const doc = [paragraph("first\n[abc"), bullet("next")];

    expect(roundTrip(doc)).toEqual(doc);
  });

  it("leaves a bracket inside a line escaped as before", () => {
    expect(slateToMarkdown([paragraph("see [a] b")])).toBe("see \\[a\\] b\n");
  });

  it("does not form a wikilink or a link", () => {
    expect(slateToMarkdown([paragraph("[[a]]")])).not.toMatch(/^\[\[/);
    expect(roundTrip([paragraph("[a](b)")])).toEqual([paragraph("[a](b)")]);
  });

  it("authored display math still reads as math", () => {
    expect(markdownToSlate("\\[x\\]\n")[0]).toHaveProperty(
      "type",
      "math-block",
    );
  });

  it("an authored empty task marker still reads as a task", () => {
    expect(markdownToSlate("- [ ]\n")).toEqual([
      {
        type: "bulleted-list",
        children: [
          { type: "list-item", checked: false, children: [paragraph("")] },
        ],
      },
    ]);
  });
});
