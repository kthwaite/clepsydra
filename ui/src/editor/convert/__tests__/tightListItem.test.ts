import { createEditor, type Descendant, Editor } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "../../schema/withSchema";
import { markdownToSlate, slateToMarkdown } from "../index";

const paragraph = (text: string) =>
  ({ type: "paragraph", children: [{ text }] }) as Descendant;
const item = (...children: Descendant[]) =>
  ({ type: "list-item", children }) as Descendant;
const bullets = (...children: Descendant[]) =>
  ({ type: "bulleted-list", children }) as Descendant;
const rule = { type: "thematic-break", children: [{ text: "" }] } as Descendant;
const quote = {
  type: "blockquote",
  children: [paragraph("q")],
} as Descendant;

function roundTrip(doc: Descendant[]) {
  const editor = withSchema(createEditor());
  editor.children = markdownToSlate(slateToMarkdown(doc));
  Editor.normalize(editor, { force: true });
  return editor.children;
}

describe("blocks inside one bullet, written without a blank line", () => {
  it("a paragraph after a nested list does not join the list's last item", () => {
    const doc = [
      bullets(
        item(paragraph("a"), bullets(item(paragraph("b"))), paragraph("c")),
      ),
    ];

    expect(roundTrip(doc)).toEqual(doc);
  });

  it("a divider after text does not turn the text into a heading", () => {
    const doc = [bullets(item(paragraph("a"), rule))];

    expect(roundTrip(doc)).toEqual(doc);
  });

  it("a paragraph after a blockquote does not join the quote", () => {
    const doc = [bullets(item(paragraph("a"), quote, paragraph("c")))];

    expect(roundTrip(doc)).toEqual(doc);
  });

  it("keeps a nested list tight under its parent's text", () => {
    expect(
      slateToMarkdown([
        bullets(item(paragraph("a"), bullets(item(paragraph("b"))))),
      ]),
    ).toBe("* a\n  * b\n");
  });
});
