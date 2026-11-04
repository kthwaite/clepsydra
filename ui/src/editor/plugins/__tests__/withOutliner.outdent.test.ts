import {
  createEditor,
  type Descendant,
  type Editor,
  Node,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { tryListContinuation } from "../autoformat/listContinuation";
import { outdentListItem, withOutliner } from "../withOutliner";

import "../../types";

const paragraph = (text: string) =>
  ({ type: "paragraph", children: [{ text }] }) as Descendant;
const item = (text: string, ...rest: Descendant[]) =>
  ({ type: "list-item", children: [paragraph(text), ...rest] }) as Descendant;
const bullets = (...children: Descendant[]) =>
  ({ type: "bulleted-list", children }) as Descendant;
const numbers = (...children: Descendant[]) =>
  ({ type: "numbered-list", children }) as Descendant;

function makeEditor(children: Descendant[]) {
  const editor = withOutliner(withHistory(createEditor()));
  editor.children = children;
  return editor;
}

function caretOn(editor: Editor, text: string) {
  for (const [node, path] of Node.texts(editor)) {
    if (node.text === text) {
      Transforms.select(editor, { path, offset: 0 });
      return;
    }
  }
  throw new Error(`no text ${text}`);
}

const reading = (editor: Editor) =>
  Array.from(Node.texts(editor), ([node]) => node.text);

describe("outdentListItem", () => {
  it("adds trailing siblings to the item's existing same-type children", () => {
    const editor = makeEditor([
      bullets(item("g", bullets(item("x", bullets(item("k"))), item("y")))),
    ]);
    caretOn(editor, "x");

    outdentListItem(editor);

    expect(editor.children).toEqual([
      bullets(item("g"), item("x", bullets(item("k"), item("y")))),
    ]);
  });

  it("keeps reading order over two outdents", () => {
    const editor = makeEditor([
      bullets(item("g", bullets(item("x", bullets(item("k"))), item("y")))),
    ]);
    caretOn(editor, "x");
    outdentListItem(editor);
    caretOn(editor, "k");

    outdentListItem(editor);

    expect(reading(editor)).toEqual(["g", "x", "k", "y"]);
  });

  it("takes a parent's later list along, so nothing jumps above the item", () => {
    const editor = makeEditor([
      bullets(item("g", bullets(item("x")), numbers(item("n")))),
    ]);
    caretOn(editor, "x");

    outdentListItem(editor);

    expect(editor.children).toEqual([
      bullets(item("g"), item("x", numbers(item("n")))),
    ]);
  });

  it("does the same for Enter on an empty nested item", () => {
    const editor = makeEditor([
      bullets(item("g", bullets(item("", bullets(item("k"))), item("y")))),
    ]);
    Transforms.select(editor, { path: [0, 0, 1, 0, 0, 0], offset: 0 });

    tryListContinuation(editor);

    expect(editor.children).toEqual([
      bullets(item("g"), item("", bullets(item("k"), item("y")))),
    ]);
  });
});
