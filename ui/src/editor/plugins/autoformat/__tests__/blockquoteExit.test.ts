/**
 * Enter on the only, empty paragraph of a blockquote, typed key by key through
 * the production plugin chain. The quote gives way to an empty paragraph in the
 * same place in the document.
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

async function enter(editor: Editor) {
  Editor.insertBreak(editor);
  await flush();
}

const paragraph = (text: string): Descendant => ({
  type: "paragraph",
  children: [{ text }],
});
const quote = (...children: Descendant[]) =>
  ({ type: "blockquote", children }) as unknown as Descendant;
const list = (text: string) =>
  ({
    type: "bulleted-list",
    children: [{ type: "list-item", children: [paragraph(text)] }],
  }) as unknown as Descendant;

describe("> then Enter", () => {
  it("leaves one empty paragraph when the quote was the only block", async () => {
    const editor = makeEditor([paragraph("")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "> ");
    await enter(editor);
    expect(editor.children).toEqual([paragraph("")]);
  });

  it("leaves the caret where the next key lands", async () => {
    const editor = makeEditor([paragraph("")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "> ");
    await enter(editor);
    await typeKeys(editor, "Z");
    expect(editor.children).toEqual([paragraph("Z")]);
  });

  it("stays below a list that came before the quote", async () => {
    const editor = makeEditor([list("before"), paragraph("")]);
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "> ");
    await enter(editor);
    await typeKeys(editor, "Z");
    expect(editor.children).toEqual([list("before"), paragraph("Z")]);
  });

  it("stays above a list that came after the quote", async () => {
    const editor = makeEditor([paragraph(""), list("after")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "> ");
    await enter(editor);
    await typeKeys(editor, "Z");
    expect(editor.children).toEqual([paragraph("Z"), list("after")]);
  });

  it("stays between the blocks around the quote", async () => {
    const editor = makeEditor([
      paragraph("above"),
      paragraph(""),
      paragraph("below"),
    ]);
    Transforms.select(editor, Editor.start(editor, [1]));
    await typeKeys(editor, "> ");
    await enter(editor);
    await typeKeys(editor, "Z");
    expect(editor.children).toEqual([
      paragraph("above"),
      paragraph("Z"),
      paragraph("below"),
    ]);
  });
});

describe("undoing the exit", () => {
  it("brings the quote back with a caret in it", async () => {
    const editor = makeEditor([paragraph("")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "> ");
    await enter(editor);
    HistoryEditor.undo(editor as HistoryEditor);
    await flush();
    expect(editor.children).toEqual([quote(paragraph(""))]);
    expect(editor.selection).not.toBeNull();
    await typeKeys(editor, "Z");
    expect(editor.children).toEqual([quote(paragraph("Z"))]);
  });

  it("undoing everything returns to the start", async () => {
    const editor = makeEditor([paragraph("")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "> ");
    await enter(editor);
    while (editor.history.undos.length > 0) {
      HistoryEditor.undo(editor as HistoryEditor);
      await flush();
    }
    expect(editor.children).toEqual([paragraph("")]);
  });
});

describe("Enter on an empty paragraph after others in a quote", () => {
  it("keeps the quote and steps out below it", async () => {
    const editor = makeEditor([quote(paragraph("a"), paragraph(""))]);
    Transforms.select(editor, Editor.end(editor, []));
    await enter(editor);
    await typeKeys(editor, "Z");
    expect(editor.children).toEqual([quote(paragraph("a")), paragraph("Z")]);
  });
});
