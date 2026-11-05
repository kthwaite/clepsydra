import { createEditor, type Descendant, Editor } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "../../schema/withSchema";
import { markdownToSlate, slateToMarkdown } from "../index";

const leafItem = (leaf: object) =>
  ({
    type: "list-item",
    children: [{ type: "paragraph", children: [leaf] }],
  }) as Descendant;
const bullets = (...children: Descendant[]) =>
  ({ type: "bulleted-list", children }) as Descendant;
const blank = {
  type: "list-item",
  children: [{ type: "paragraph", children: [{ text: "" }] }],
};

function reload(doc: Descendant[]) {
  const editor = withSchema(createEditor());
  editor.children = markdownToSlate(slateToMarkdown(doc));
  Editor.normalize(editor, { force: true });
  return editor.children;
}

describe("a text leaf left empty with a mark still set", () => {
  it.each([
    ["bold", { bold: true }],
    ["italic", { italic: true }],
    ["code", { code: true }],
    ["strikethrough", { strikethrough: true }],
    ["underline", { underline: true }],
    ["bold italic", { bold: true, italic: true }],
    ["color", { color: "red" }],
  ])("%s writes nothing for the mark", (_name, marks) => {
    const doc = [bullets(leafItem({ text: "", ...marks }))];

    expect(slateToMarkdown(doc)).toBe("*\n");
  });

  it("a bold bullet does not reload as a thematic break", () => {
    const doc = [bullets(leafItem({ text: "", bold: true }))];

    expect(reload(doc)).toEqual([bullets(blank as Descendant)]);
  });

  it("an empty bold paragraph does not reload as a thematic break", () => {
    const doc = [
      { type: "paragraph", children: [{ text: "above" }] },
      { type: "paragraph", children: [{ text: "", bold: true }] },
    ] as Descendant[];

    expect(slateToMarkdown(doc)).not.toContain("****");
  });

  it("marks on real text are unchanged", () => {
    const doc = [bullets(leafItem({ text: "x", bold: true }))];

    expect(slateToMarkdown(doc)).toBe("* **x**\n");
  });
});
