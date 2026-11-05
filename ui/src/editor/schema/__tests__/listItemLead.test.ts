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
  // The page loads the parser's output as is: Slate does not normalize an
  // initial value, so these assert on what `markdownToSlate` itself returns.
  it("a saved empty bullet loads with a line the caret can reach", () => {
    const loaded = markdownToSlate("* a\n*\n* b\n");

    expect(loaded).toEqual([list(item("a"), item(""), item("b"))]);

    const editor = makeEditor(loaded);
    expect(Editor.start(editor, [0, 1]).path).toEqual([0, 1, 0, 0]);
  });

  it("a saved empty numbered item loads with a line", () => {
    expect(markdownToSlate("1. a\n2.\n")).toEqual([
      {
        type: "numbered-list",
        children: [item("a"), item("")],
      },
    ]);
  });

  it("a saved empty child bullet loads with a line", () => {
    expect(markdownToSlate("* a\n\n  *\n")).toEqual([
      list(item("a", list(item("")))),
    ]);
  });

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

describe("a task always leads with a paragraph", () => {
  const code = (text: string) =>
    ({ type: "code-block", children: [{ text }] }) as Descendant;
  const task = (...children: Descendant[]) =>
    ({ type: "list-item", checked: true, children }) as Descendant;

  it("Delete on an emptied task's lead keeps a line for the checkbox", () => {
    const editor = makeEditor([list(task(paragraph(""), code("c")))]);
    Transforms.select(editor, Editor.start(editor, [0, 0, 0]));

    editor.deleteForward("character");

    expect(editor.children).toEqual([list(task(paragraph(""), code("c")))]);
  });

  it("a transform replacing a task's lead with a block leaves it a line", () => {
    const editor = makeEditor([list(task(paragraph("")))]);

    Editor.withoutNormalizing(editor, () => {
      Transforms.removeNodes(editor, { at: [0, 0, 0] });
      Transforms.insertNodes(editor, code("c"), { at: [0, 0, 0] });
    });

    expect(editor.children).toEqual([list(task(paragraph(""), code("c")))]);
  });

  it("a plain item may still lead with a block", () => {
    const editor = makeEditor([
      list({ type: "list-item", children: [paragraph("")] } as Descendant),
    ]);

    Editor.withoutNormalizing(editor, () => {
      Transforms.removeNodes(editor, { at: [0, 0, 0] });
      Transforms.insertNodes(editor, code("c"), { at: [0, 0, 0] });
    });

    expect(editor.children).toEqual([
      list({ type: "list-item", children: [code("c")] } as Descendant),
    ]);
  });
});
