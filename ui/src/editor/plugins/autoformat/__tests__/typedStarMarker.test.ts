/**
 * `*` auto-pairs, so a Space typed straight after it finds the closer still in
 * the text. Typed key by key through the production plugin chain.
 */
import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { withBlockVoidDeletion } from "#/editor/plugins/withBlockVoidDeletion";
import { withInlinePunctuationBoundary } from "#/editor/plugins/withInlinePunctuationBoundary";
import { withMarkdownPaste } from "#/editor/plugins/withMarkdownPaste";
import { withMathClipboard } from "#/editor/plugins/withMathClipboard";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { withTables } from "#/editor/plugins/withTables";
import { withSchema } from "#/editor/schema/withSchema";
import { withAutoformat } from "../withAutoformat";

function makeEditor(children: Descendant[]): Editor {
  const editor = withMathClipboard(
    withMarkdownPaste(
      withReact(
        withInlinePunctuationBoundary(
          withHistory(
            withAutoformat(
              withOutliner(
                withBlockVoidDeletion(withTables(withSchema(createEditor()))),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  editor.children = children;
  return editor;
}

const flush = () => Promise.resolve();

async function typeKeys(editor: Editor, keys: string) {
  for (const key of keys) {
    Editor.insertText(editor, key);
    await flush();
  }
}

const paragraph = (text: string): Descendant => ({
  type: "paragraph",
  children: [{ text }],
});
const list = (text: string): Descendant => ({
  type: "bulleted-list",
  children: [{ type: "list-item", children: [paragraph(text)] }],
});

describe("the * bullet marker", () => {
  it("leaves an empty bullet on an empty paragraph", async () => {
    const editor = makeEditor([paragraph("")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "* ");
    expect(editor.children).toEqual([list("")]);
  });

  it("keeps the text after it and adds no asterisk", async () => {
    const editor = makeEditor([paragraph("abc")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "* ");
    expect(editor.children).toEqual([list("abc")]);
  });

  it("keeps an asterisk that no auto-pair inserted", async () => {
    const editor = makeEditor([paragraph("**abc")]);
    const start = Editor.start(editor, []);
    Transforms.select(editor, { path: start.path, offset: 1 });
    await typeKeys(editor, " ");
    expect(editor.children).toEqual([list("*abc")]);
  });

  it("restores the start after undoing everything", async () => {
    const editor = makeEditor([paragraph("abc")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "* ");
    while (editor.history.undos.length > 0) {
      HistoryEditor.undo(editor as HistoryEditor);
      await flush();
    }
    expect(editor.children).toEqual([paragraph("abc")]);
  });
});

describe("a Space straight after an auto-paired delimiter", () => {
  it.each([
    ["2 * 3", "2 * 3"],
    ["a _ b", "a _ b"],
  ])("%s keeps only what was typed", async (keys, text) => {
    const editor = makeEditor([paragraph("")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, keys);
    expect(editor.children).toEqual([paragraph(text)]);
  });

  it("does not take a character after an undone pair", async () => {
    const editor = makeEditor([paragraph("abc")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "*");
    HistoryEditor.undo(editor as HistoryEditor);
    await flush();
    await typeKeys(editor, "z ");
    expect(editor.children).toEqual([paragraph("z abc")]);
  });
});

describe("emphasis typed through an auto-pair", () => {
  it.each([
    ["*x*", { text: "x", italic: true }],
    ["**x**", { text: "x", bold: true }],
  ])("%s still converts", async (keys, leaf) => {
    const editor = makeEditor([paragraph("")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, keys);
    expect(editor.children).toEqual([{ type: "paragraph", children: [leaf] }]);
  });
});
