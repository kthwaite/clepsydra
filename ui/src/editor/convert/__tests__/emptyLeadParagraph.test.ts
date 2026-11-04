import type { Descendant } from "slate";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../index";

const paragraph = (text: string) =>
  ({ type: "paragraph", children: [{ text }] }) as Descendant;
const item = (...children: Descendant[]) =>
  ({ type: "list-item", children }) as Descendant;
const list = (...children: Descendant[]) =>
  ({ type: "bulleted-list", children }) as Descendant;

describe("a bullet whose first paragraph is empty, with text after it", () => {
  it("keeps the text in the list across save and reload", () => {
    const doc = [list(item(paragraph(""), paragraph("text")))];

    expect(markdownToSlate(slateToMarkdown(doc))).toEqual([
      list(item(paragraph("text"))),
    ]);
  });

  it("does not swallow the following bullets into a paragraph", () => {
    const doc = [
      list(item(paragraph(""), paragraph("text")), item(paragraph("next"))),
    ];

    expect(markdownToSlate(slateToMarkdown(doc))).toEqual([
      list(item(paragraph("text")), item(paragraph("next"))),
    ]);
  });

  it("drops every leading empty paragraph before the text", () => {
    const doc = [list(item(paragraph(""), paragraph(""), paragraph("text")))];

    expect(slateToMarkdown(doc)).toBe("* text\n");
  });

  it("keeps a task's checkbox", () => {
    const doc = [
      list({
        type: "list-item",
        checked: true,
        children: [paragraph(""), paragraph("text")],
      } as Descendant),
    ];

    expect(slateToMarkdown(doc)).toBe("* [x] text\n");
  });

  it("keeps a second paragraph that follows real text", () => {
    const doc = [list(item(paragraph("first"), paragraph("second")))];

    expect(markdownToSlate(slateToMarkdown(doc))).toEqual(doc);
  });

  it("leaves a lone empty bullet alone", () => {
    expect(slateToMarkdown([list(item(paragraph("")))])).toBe("*\n");
  });
});
