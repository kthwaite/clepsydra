/**
 * Display math inside a list item or blockquote. The parser hands over the raw
 * source, so each continuation line carries its container's prefix. If that stays
 * in the tex, the next save writes the prefix again and the file grows per save.
 */
import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { withAutoformat } from "#/editor/plugins/autoformat/withAutoformat";
import { withBlockVoidDeletion } from "#/editor/plugins/withBlockVoidDeletion";
import { withInlinePunctuationBoundary } from "#/editor/plugins/withInlinePunctuationBoundary";
import { withMarkdownPaste } from "#/editor/plugins/withMarkdownPaste";
import { withMathClipboard } from "#/editor/plugins/withMathClipboard";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { withTables } from "#/editor/plugins/withTables";
import { withSchema } from "#/editor/schema/withSchema";

function firstTex(nodes: Descendant[]): string | undefined {
  for (const node of nodes) {
    if ("text" in node) continue;
    const el = node as unknown as {
      type: string;
      tex?: string;
      children: Descendant[];
    };
    if (el.type === "math-block") return el.tex;
    const inner = firstTex(el.children);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

const save = (nodes: Descendant[]) =>
  slateToMarkdown(JSON.parse(JSON.stringify(nodes)));

describe.each<[string, string, string]>([
  ["a list item", "- lead\n\n  $$\n  x\n  $$\n", "\nx\n"],
  ["a list item it leads", "- $$\n  x\n  $$\n", "\nx\n"],
  ["a numbered item", "1. lead\n\n   $$\n   x\n   $$\n", "\nx\n"],
  ["a nested item", "- a\n  - b\n\n    $$\n    x\n    $$\n", "\nx\n"],
  ["a blockquote", "> $$\n> x\n> $$\n", "\nx\n"],
  ["a quote in an item", "- a\n\n  > $$\n  > x\n  > $$\n", "\nx\n"],
  ["an item in a quote", "> - a\n>\n>   $$\n>   x\n>   $$\n", "\nx\n"],
  ["no container", "$$\nx\n$$\n", "\nx\n"],
  ["backslash delimiters in an item", "- a\n\n  \\[\n  x\n  \\]\n", "\nx\n"],
  ["several lines in an item", "- a\n\n  $$\n  x\n  y\n  $$\n", "\nx\ny\n"],
  ["its own indent in an item", "- a\n\n  $$\n    x\n  $$\n", "\n  x\n"],
  ["a line starting > in a quote", "> $$\n> > x\n> $$\n", "\n> x\n"],
  ["a line starting > in an item", "- a\n\n  $$\n  > x\n  $$\n", "\n> x\n"],
])("display math in %s", (_name, source, tex) => {
  it("loads with only its own source", () => {
    expect(firstTex(markdownToSlate(source))).toBe(tex);
  });

  it("reaches a fixed point after one save", () => {
    const once = save(markdownToSlate(source));
    const twice = save(markdownToSlate(once));
    const thrice = save(markdownToSlate(twice));
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
    expect(firstTex(markdownToSlate(thrice))).toBe(tex);
  });
});

describe("display math typed into an item's later paragraph", () => {
  it("does not grow across saves", async () => {
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
    editor.children = [
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "lead" }] },
              { type: "paragraph", children: [{ text: "" }] },
            ],
          },
        ],
      },
    ] as Descendant[];
    Transforms.select(editor, Editor.start(editor, [0, 0, 1]));
    for (const key of "$$x$$") {
      Editor.insertText(editor, key);
      await Promise.resolve();
    }
    const once = save(editor.children);
    const twice = save(markdownToSlate(once));
    const thrice = save(markdownToSlate(twice));
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
    expect(firstTex(markdownToSlate(thrice))?.trim()).toBe("x");
  });
});
