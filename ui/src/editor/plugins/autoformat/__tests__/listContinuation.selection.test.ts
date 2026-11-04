import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
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

const textPoint = (path: number[], offset: number) => ({ path, offset });

describe("Enter over a selection in a bullet", () => {
  it("replaces the selection and starts a new bullet", () => {
    const editor = makeEditor([list(item("abcd"))]);
    Transforms.select(editor, {
      anchor: textPoint([0, 0, 0, 0], 1),
      focus: textPoint([0, 0, 0, 0], 3),
    });

    expect(tryListContinuation(editor)).toBe(true);

    expect(editor.children).toEqual([list(item("a"), item("d"))]);
    expect(editor.selection?.anchor).toEqual(textPoint([0, 1, 0, 0], 0));
  });

  it("joins the ends of a selection across two bullets, then splits", () => {
    const editor = makeEditor([list(item("abc"), item("def"))]);
    Transforms.select(editor, {
      anchor: textPoint([0, 0, 0, 0], 1),
      focus: textPoint([0, 1, 0, 0], 2),
    });

    tryListContinuation(editor);

    expect(editor.children).toEqual([list(item("a"), item("f"))]);
  });

  it("stays in the list when the whole of a bullet's text is selected", () => {
    const editor = makeEditor([list(item("abc"))]);
    Transforms.select(editor, {
      anchor: textPoint([0, 0, 0, 0], 0),
      focus: textPoint([0, 0, 0, 0], 3),
    });

    tryListContinuation(editor);

    expect(editor.children).toEqual([list(item(""), item(""))]);
  });

  it("works backwards the same way", () => {
    const editor = makeEditor([list(item("abcd"))]);
    Transforms.select(editor, {
      anchor: textPoint([0, 0, 0, 0], 3),
      focus: textPoint([0, 0, 0, 0], 1),
    });

    tryListContinuation(editor);

    expect(editor.children).toEqual([list(item("a"), item("d"))]);
  });

  it("undoes as one step", async () => {
    const editor = makeEditor([list(item("abcd"))]);
    const start = JSON.stringify(editor.children);
    Transforms.select(editor, {
      anchor: textPoint([0, 0, 0, 0], 1),
      focus: textPoint([0, 0, 0, 0], 3),
    });
    await Promise.resolve();

    tryListContinuation(editor);
    await Promise.resolve();
    HistoryEditor.undo(editor as HistoryEditor);

    expect(JSON.stringify(editor.children)).toBe(start);
  });

  it("leaves a selection that starts outside the list to the default", () => {
    const editor = makeEditor([paragraph("para"), list(item("abc"))]);
    const before = JSON.stringify(editor.children);
    Transforms.select(editor, {
      anchor: textPoint([0, 0], 2),
      focus: textPoint([1, 0, 0, 0], 1),
    });

    expect(tryListContinuation(editor)).toBe(false);

    expect(JSON.stringify(editor.children)).toBe(before);
    expect(Editor.string(editor, [])).toBe("paraabc");
  });
});
