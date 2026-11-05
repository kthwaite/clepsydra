/**
 * Display math typed into an empty task, key by key through the production plugin
 * chain, then saved and reloaded. GFM writes a checkbox above a paragraph, so a
 * task keeps its lead paragraph and the math goes after it. A plain bullet may
 * lead with math; withAutoformat.test.ts pins that.
 */
import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
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
const list = (...items: unknown[]) =>
  ({ type: "bulleted-list", children: items }) as unknown as Descendant;
const task = (checked: boolean, ...children: Descendant[]) => ({
  type: "list-item",
  checked,
  children,
});
const math = (tex: string, delimiter: string) =>
  ({
    type: "math-block",
    tex,
    delimiter,
    children: [{ text: "" }],
  }) as unknown as Descendant;

const reload = (children: Descendant[]) =>
  markdownToSlate(slateToMarkdown(JSON.parse(JSON.stringify(children))));

const firstItem = (nodes: Descendant[]) =>
  (
    nodes[0] as unknown as {
      children: Array<{
        checked?: boolean;
        properties?: Record<string, string>;
        children: Array<{ type: string; tex?: string }>;
      }>;
    }
  ).children[0];

describe.each<[string, string]>([
  ["$$x$$", "$$"],
  [String.raw`\[x\]`, "\\["],
])("%s typed in an empty task", (keys, delimiter) => {
  it.each([[false], [true]])(
    "keeps the lead paragraph above the math (checked %s)",
    async (checked) => {
      const editor = makeEditor([list(task(checked, paragraph("")))]);
      Transforms.select(editor, Editor.start(editor, []));
      await typeKeys(editor, keys);
      expect(editor.children).toEqual([
        list(task(checked, paragraph(""), math("x", delimiter), paragraph(""))),
      ]);
    },
  );

  it.each([[false], [true]])(
    "keeps the checkbox and the math across a reload (checked %s)",
    async (checked) => {
      const editor = makeEditor([list(task(checked, paragraph("")))]);
      Transforms.select(editor, Editor.start(editor, []));
      await typeKeys(editor, keys);
      const item = firstItem(reload(editor.children));
      expect(item.checked).toBe(checked);
      expect(item.children[0].type).toBe("paragraph");
      expect(item.children[1].type).toBe("math-block");
      expect(item.children[1].tex?.trim()).toBe("x");
    },
  );

  it("keeps a property on the task across a reload", async () => {
    const editor = makeEditor([
      list({
        ...task(false, paragraph("")),
        properties: { due: "2026-01-01" },
      }),
    ]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, keys);
    const item = firstItem(reload(editor.children));
    expect(item.checked).toBe(false);
    expect(item.properties).toEqual({ due: "2026-01-01" });
  });

  it("leaves the caret below the math, where the next key lands", async () => {
    const editor = makeEditor([list(task(false, paragraph("")))]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, `${keys}Z`);
    expect(editor.children).toEqual([
      list(task(false, paragraph(""), math("x", delimiter), paragraph("Z"))),
    ]);
  });

  it("undoes to the start", async () => {
    const before = [list(task(false, paragraph("")))];
    const editor = makeEditor(JSON.parse(JSON.stringify(before)));
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, keys);
    while (editor.history.undos.length > 0) {
      HistoryEditor.undo(editor as HistoryEditor);
      await flush();
    }
    expect(editor.children).toEqual(before);
  });
});

describe("display math typed elsewhere", () => {
  it("still leads a plain bullet", async () => {
    const editor = makeEditor([
      list({ type: "list-item", children: [paragraph("")] }),
    ]);
    Transforms.select(editor, Editor.start(editor, []));
    await typeKeys(editor, "$$x$$");
    expect(editor.children).toEqual([
      list({
        type: "list-item",
        children: [math("x", "$$"), paragraph("")],
      }),
    ]);
  });

  it("converts in a task's later paragraph without touching the lead", async () => {
    const editor = makeEditor([
      list(task(false, paragraph("job"), paragraph(""))),
    ]);
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "$$x$$");
    expect(editor.children).toEqual([
      list(task(false, paragraph("job"), math("x", "$$"), paragraph(""))),
    ]);
  });

  it("stays literal after text in a task", async () => {
    const editor = makeEditor([list(task(false, paragraph("job ")))]);
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "$$x$$");
    expect(editor.children).toEqual([
      list(task(false, paragraph("job $$x$$"))),
    ]);
  });
});
