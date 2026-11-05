/**
 * `---` typed in a list item, key by key through the production plugin chain. A
 * list item leads with a paragraph, so the dashes stay literal there.
 */
import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
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
const item = (...children: Descendant[]) =>
  ({ type: "list-item", children }) as unknown as Descendant;
const list = (...items: Descendant[]) =>
  ({ type: "bulleted-list", children: items }) as unknown as Descendant;

function caretIn(editor: Editor, path: number[]) {
  Transforms.select(editor, Editor.start(editor, path));
}

describe("--- typed in a list item", () => {
  it("stays literal in an empty item", async () => {
    const editor = makeEditor([
      list(item(paragraph("a")), item(paragraph(""))),
    ]);
    caretIn(editor, [0, 1, 0]);
    await typeKeys(editor, "---");
    expect(editor.children).toEqual([
      list(item(paragraph("a")), item(paragraph("---"))),
    ]);
  });

  it("keeps a task's checkbox across a reload", async () => {
    const task = {
      type: "list-item",
      checked: false,
      children: [paragraph("")],
    } as unknown as Descendant;
    const editor = makeEditor([list(task)]);
    caretIn(editor, [0, 0, 0]);
    await typeKeys(editor, "---");
    const saved = slateToMarkdown(JSON.parse(JSON.stringify(editor.children)));
    expect(markdownToSlate(saved)).toEqual([
      list({ ...task, children: [paragraph("---")] } as unknown as Descendant),
    ]);
  });

  it("stays literal in an item's later paragraph", async () => {
    const editor = makeEditor([list(item(paragraph("a"), paragraph("")))]);
    caretIn(editor, [0, 0, 1]);
    await typeKeys(editor, "---");
    expect(editor.children).toEqual([
      list(item(paragraph("a"), paragraph("---"))),
    ]);
  });

  it("leaves a caret that still takes typing after Backspace", async () => {
    const editor = makeEditor([list(item(paragraph("")))]);
    caretIn(editor, [0, 0, 0]);
    await typeKeys(editor, "---");
    Editor.deleteBackward(editor, { unit: "character" });
    await flush();
    await typeKeys(editor, "Z");
    expect(editor.children).toEqual([list(item(paragraph("--Z")))]);
  });
});

describe("--- typed outside a list", () => {
  it("still makes a thematic break", async () => {
    const editor = makeEditor([paragraph("")]);
    caretIn(editor, [0]);
    await typeKeys(editor, "---");
    expect(editor.children).toEqual([
      { type: "thematic-break", children: [{ text: "" }] },
      paragraph(""),
    ]);
  });

  it("still makes a thematic break in a blockquote", async () => {
    const quote = (...children: Descendant[]) =>
      ({ type: "blockquote", children }) as unknown as Descendant;
    const editor = makeEditor([quote(paragraph(""))]);
    caretIn(editor, [0, 0]);
    await typeKeys(editor, "---");
    expect(editor.children).toEqual([
      quote(
        { type: "thematic-break", children: [{ text: "" }] } as Descendant,
        paragraph(""),
      ),
    ]);
  });
});
