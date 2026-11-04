import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../../convert";
import { withOutliner } from "../../plugins/withOutliner";
import { withSchema } from "../withSchema";

import "../../types";

const paragraph = (text: string) =>
  ({ type: "paragraph", children: [{ text }] }) as Descendant;
const item = (text: string, ...rest: Descendant[]) =>
  ({ type: "list-item", children: [paragraph(text), ...rest] }) as Descendant;
const list = (...children: Descendant[]) =>
  ({ type: "bulleted-list", children }) as Descendant;

function makeEditor(children: Descendant[]) {
  const editor = withOutliner(withSchema(withHistory(createEditor())));
  editor.children = children;
  return editor;
}

describe("a bullet always has its own line", () => {
  it("reloading an empty parent keeps a paragraph above its children", () => {
    const saved = slateToMarkdown([list(item("", list(item("kid"))))]);

    expect(markdownToSlate(saved)).toEqual([list(item("", list(item("kid"))))]);
  });

  it("reloading gives the caret a place on the empty parent line", () => {
    const editor = makeEditor(markdownToSlate("-\n  - kid\n"));

    Transforms.select(editor, Editor.start(editor, [0, 0]));

    expect(editor.selection?.anchor.path).toEqual([0, 0, 0, 0]);
  });

  it("Delete at an item's end leaves the next item's children a parent line", () => {
    const editor = makeEditor([list(item("a"), item("b", list(item("kid"))))]);
    Transforms.select(editor, Editor.end(editor, [0, 0, 0]));

    editor.deleteForward("character");

    expect(editor.children).toEqual([
      list(item("ab"), item("", list(item("kid")))),
    ]);
  });

  it("deleting a selection across items leaves the kids a parent line", () => {
    const editor = makeEditor([list(item("a"), item("b", list(item("kid"))))]);
    Transforms.select(editor, {
      anchor: { path: [0, 0, 0, 0], offset: 0 },
      focus: { path: [0, 1, 0, 0], offset: 1 },
    });

    Editor.deleteFragment(editor);

    expect(editor.children).toEqual([
      list(item(""), item("", list(item("kid")))),
    ]);
  });

  it("the document stays the same across save and reload after that delete", () => {
    const editor = makeEditor([list(item("a"), item("b", list(item("kid"))))]);
    Transforms.select(editor, Editor.end(editor, [0, 0, 0]));
    editor.deleteForward("character");

    const reloaded = markdownToSlate(slateToMarkdown(editor.children));

    expect(reloaded).toEqual(editor.children);
  });
});
