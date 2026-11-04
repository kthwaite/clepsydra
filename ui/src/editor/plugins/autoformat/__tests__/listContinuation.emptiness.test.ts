import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { slateToMarkdown } from "../../../convert";
import { withSchema } from "../../../schema/withSchema";
import { withOutliner } from "../../withOutliner";
import { withAutoformat } from "../withAutoformat";

import "../../../types";

function makeEditor(children: Descendant[]) {
  const editor = withHistory(
    withAutoformat(withOutliner(withSchema(createEditor()))),
  );
  editor.children = children;
  return editor;
}

const wikilinkOnly = (): Descendant =>
  ({
    type: "paragraph",
    children: [
      { text: "" },
      { type: "wikilink", target: "Foo", children: [{ text: "" }] },
      { text: "" },
    ],
  }) as Descendant;

const item = (...children: Descendant[]) =>
  ({ type: "list-item", children }) as Descendant;
const list = (...children: Descendant[]) =>
  ({ type: "bulleted-list", children }) as Descendant;
const paragraph = (text: string) =>
  ({ type: "paragraph", children: [{ text }] }) as Descendant;

describe("Enter does not take a block with content for an empty one", () => {
  it("adds a bullet after a top-level item holding only a wikilink", () => {
    const editor = makeEditor([list(item(wikilinkOnly()))]);
    Transforms.select(editor, Editor.end(editor, [0, 0, 0]));

    editor.insertBreak();

    expect(slateToMarkdown(editor.children)).toBe("* [[Foo]]\n*\n");
  });

  it("adds a bullet after a nested item holding only a wikilink", () => {
    const editor = makeEditor([
      list(item(paragraph("parent"), list(item(wikilinkOnly())))),
    ]);
    Transforms.select(editor, Editor.end(editor, [0, 0, 1, 0, 0]));

    editor.insertBreak();

    expect(slateToMarkdown(editor.children)).toBe(
      "* parent\n  * [[Foo]]\n  *\n",
    );
  });

  it("keeps a blockquote paragraph holding only a wikilink", () => {
    const editor = makeEditor([
      { type: "blockquote", children: [wikilinkOnly()] } as Descendant,
    ]);
    Transforms.select(editor, Editor.end(editor, [0, 0]));

    editor.insertBreak();

    expect(slateToMarkdown(editor.children)).toContain("[[Foo]]");
  });

  it("keeps a later paragraph when the item's first paragraph is empty", () => {
    const editor = makeEditor([list(item(paragraph(""), paragraph("later")))]);
    Transforms.select(editor, Editor.end(editor, [0, 0, 1]));

    editor.insertBreak();

    expect(slateToMarkdown(editor.children)).toContain("later");
  });

  it("keeps the heading of an item that has no paragraph", () => {
    const editor = makeEditor([
      list(
        item({
          type: "heading",
          level: 2,
          children: [{ text: "title" }],
        } as Descendant),
      ),
    ]);
    Transforms.select(editor, Editor.end(editor, [0, 0, 0]));

    editor.insertBreak();

    expect(slateToMarkdown(editor.children)).toContain("title");
  });
});
