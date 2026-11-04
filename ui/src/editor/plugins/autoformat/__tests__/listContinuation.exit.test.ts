import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { slateToMarkdown } from "../../../convert";
import { withOutliner } from "../../withOutliner";
import { tryListContinuation } from "../listContinuation";

import "../../../types";

const paragraph = (text: string) =>
  ({ type: "paragraph", children: [{ text }] }) as Descendant;
const item = (text: string, ...rest: Descendant[]) =>
  ({ type: "list-item", children: [paragraph(text), ...rest] }) as Descendant;
const list = (...children: Descendant[]) =>
  ({ type: "bulleted-list", children }) as Descendant;

function makeEditor(children: Descendant[]) {
  const editor = withOutliner(withHistory(createEditor()));
  editor.children = children;
  return editor;
}

describe("Enter on an empty top-level item", () => {
  it("keeps the item's children", () => {
    const editor = makeEditor([list(item("", list(item("kid"))))]);
    Transforms.select(editor, Editor.start(editor, [0, 0, 0]));

    expect(tryListContinuation(editor)).toBe(true);

    expect(editor.children).toEqual([paragraph(""), list(item("kid"))]);
  });

  it("splits the list so the items below stay below", () => {
    const editor = makeEditor([list(item("above"), item(""), item("below"))]);
    Transforms.select(editor, Editor.start(editor, [0, 1, 0]));

    expect(tryListContinuation(editor)).toBe(true);

    expect(editor.children).toEqual([
      list(item("above")),
      paragraph(""),
      list(item("below")),
    ]);
    expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 });
  });

  it("undoes as one step", async () => {
    const editor = makeEditor([
      list(item("", list(item("kid"))), item("next")),
    ]);
    const start = JSON.stringify(editor.children);
    Transforms.select(editor, Editor.start(editor, [0, 0, 0]));
    await Promise.resolve();

    tryListContinuation(editor);
    await Promise.resolve();
    HistoryEditor.undo(editor as HistoryEditor);

    expect(JSON.stringify(editor.children)).toBe(start);
  });

  it("saves the children in the document", () => {
    const editor = makeEditor([list(item("", list(item("kid"))))]);
    Transforms.select(editor, Editor.start(editor, [0, 0, 0]));

    tryListContinuation(editor);

    expect(slateToMarkdown(editor.children)).toContain("kid");
  });
});
