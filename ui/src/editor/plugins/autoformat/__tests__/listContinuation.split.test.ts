import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
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

describe("Enter inside the text of a bullet that has children", () => {
  it("at the start, the text stays above its children", () => {
    const editor = makeEditor([list(item("parent", list(item("kid"))))]);
    Transforms.select(editor, Editor.start(editor, [0, 0, 0]));

    expect(tryListContinuation(editor)).toBe(true);

    expect(editor.children).toEqual([
      list(item(""), item("parent", list(item("kid")))),
    ]);
    expect(editor.selection?.anchor).toEqual({
      path: [0, 1, 0, 0],
      offset: 0,
    });
  });

  it("mid-text, the tail takes the children", () => {
    const editor = makeEditor([list(item("head tail", list(item("kid"))))]);
    Transforms.select(editor, { path: [0, 0, 0, 0], offset: 5 });

    expect(tryListContinuation(editor)).toBe(true);

    expect(editor.children).toEqual([
      list(item("head "), item("tail", list(item("kid")))),
    ]);
  });

  it("mid-text, the tail takes later blocks in order", () => {
    const editor = makeEditor([
      list(item("head tail", paragraph("second"), list(item("kid")))),
    ]);
    Transforms.select(editor, { path: [0, 0, 0, 0], offset: 5 });

    tryListContinuation(editor);

    expect(editor.children).toEqual([
      list(item("head "), item("tail", paragraph("second"), list(item("kid")))),
    ]);
  });

  it("mid-text in a later paragraph, earlier blocks stay", () => {
    const editor = makeEditor([
      list(item("lead", paragraph("ab"), list(item("kid")))),
    ]);
    Transforms.select(editor, { path: [0, 0, 1, 0], offset: 1 });

    tryListContinuation(editor);

    expect(editor.children).toEqual([
      list(item("lead", paragraph("a")), item("b", list(item("kid")))),
    ]);
  });
});
