import { createEditor, type Descendant, Editor } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "../../schema/withSchema";
import { markdownToSlate, slateToMarkdown } from "../index";

const paragraph = (text: string) =>
  ({ type: "paragraph", children: [{ text }] }) as Descendant;
const item = (text: string, ...rest: Descendant[]) =>
  ({ type: "list-item", children: [paragraph(text), ...rest] }) as Descendant;
const bullets = (...children: Descendant[]) =>
  ({ type: "bulleted-list", children }) as Descendant;
const numbers = (...children: Descendant[]) =>
  ({ type: "numbered-list", children }) as Descendant;

function roundTrip(doc: Descendant[]) {
  const editor = withSchema(createEditor());
  editor.children = markdownToSlate(slateToMarkdown(doc));
  Editor.normalize(editor, { force: true });
  return editor.children;
}

describe("an empty child bullet directly under its parent's text", () => {
  it("does not become part of the parent's text", () => {
    const doc = [bullets(item("parent", bullets(item(""))))];

    expect(roundTrip(doc)).toEqual(doc);
  });

  it("works in numbered lists", () => {
    const doc = [numbers(item("parent", numbers(item(""))))];

    expect(roundTrip(doc)).toEqual(doc);
  });

  it("works when non-empty siblings follow", () => {
    const doc = [bullets(item("parent", bullets(item(""), item("next"))))];

    expect(roundTrip(doc)).toEqual(doc);
  });

  it("works at depth", () => {
    const doc = [
      bullets(
        item("a", bullets(item("b", bullets(item("c", bullets(item(""))))))),
      ),
    ];

    expect(roundTrip(doc)).toEqual(doc);
  });

  it("works when the parent's text is a link", () => {
    const doc = [
      bullets({
        type: "list-item",
        children: [
          {
            type: "paragraph",
            children: [
              { text: "" },
              { type: "wikilink", target: "Foo", children: [{ text: "" }] },
              { text: "" },
            ],
          },
          bullets(item("")),
        ],
      } as Descendant),
    ];

    expect(roundTrip(doc)).toEqual(doc);
  });

  it("keeps a tight list when the child has text", () => {
    expect(
      slateToMarkdown([bullets(item("parent", bullets(item("kid"))))]),
    ).toBe("* parent\n  * kid\n");
  });

  it("does not add a blank line under an empty parent", () => {
    expect(slateToMarkdown([bullets(item("", bullets(item(""))))])).toBe(
      "*\n  *\n",
    );
  });
});
