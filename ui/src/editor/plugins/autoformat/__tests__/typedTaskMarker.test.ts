/**
 * Task markers typed key by key through the production plugin chain. The `]` of
 * `[ ]` runs the link scaffold first, so seeding `[ ]` as text would miss it.
 */
import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
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

async function typeKeys(editor: Editor, keys: string) {
  for (const key of keys) {
    Editor.insertText(editor, key);
    await Promise.resolve();
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
const task = (text: string, checked: boolean): Descendant => ({
  type: "bulleted-list",
  children: [{ type: "list-item", checked, children: [paragraph(text)] }],
});

describe("a task marker typed at the start of a block", () => {
  it.each([
    ["[ ] ", false],
    ["[x] ", true],
    ["[X] ", true],
  ])(
    "%s in a list item makes a task and keeps the text",
    async (keys, checked) => {
      const editor = makeEditor([list("buy milk")]);
      Transforms.select(editor, Editor.start(editor, []));
      await typeKeys(editor, keys);
      expect(editor.children).toEqual([task("buy milk", checked)]);
    },
  );

  it.each([
    ["[ ] ", false],
    ["[x] ", true],
  ])("%s in a paragraph makes a task list", async (keys, checked) => {
    const editor = makeEditor([paragraph("")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, `${keys}done`);
    expect(editor.children).toEqual([task("done", checked)]);
  });
});

describe("the link scaffold around a task marker", () => {
  it("keeps scaffolding any other label at the start of a block", async () => {
    const editor = makeEditor([paragraph("")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "[y]");
    expect(editor.children).toEqual([paragraph("[y]()")]);
  });

  it("keeps scaffolding [x] after other text, where no task can start", async () => {
    const editor = makeEditor([paragraph("see ")]);
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "[x]");
    expect(editor.children).toEqual([paragraph("see [x]()")]);
  });

  it("still makes a link from [x](u) typed at the start of a block", async () => {
    const editor = makeEditor([paragraph("")]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "[x](u)");
    const [block] = editor.children as Array<{ children: unknown[] }>;
    expect(block.children).toEqual([
      { text: "" },
      { type: "link", url: "u", children: [{ text: "x" }] },
      { text: "" },
    ]);
  });
});
