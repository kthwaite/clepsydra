import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../../convert";
import { withSchema } from "../../schema/withSchema";
import { withOutliner } from "../withOutliner";

import "../../types";

function fromMarkdown(markdown: string) {
  const editor = withOutliner(withSchema(withHistory(createEditor())));
  editor.children = markdownToSlate(markdown);
  return editor;
}

function backspaceAtStart(editor: Editor, itemPath: number[]) {
  Transforms.select(editor, Editor.start(editor, itemPath));
  editor.deleteBackward("character");
}

const paragraph = (text: string, rest: object = {}) =>
  ({ type: "paragraph", ...rest, children: [{ text }] }) as Descendant;

describe("Backspace at the start of a bullet", () => {
  it("keeps the item's second paragraph", () => {
    const editor = fromMarkdown("- first\n\n  second\n");

    backspaceAtStart(editor, [0, 0]);

    expect(editor.children).toEqual([paragraph("first"), paragraph("second")]);
  });

  it("keeps the item's code block", () => {
    const editor = fromMarkdown("- first\n\n  ```\n  code\n  ```\n");

    backspaceAtStart(editor, [0, 0]);

    expect(slateToMarkdown(editor.children).trim()).toBe(
      "first\n\n```\ncode\n```",
    );
  });

  it("keeps blocks and nested lists in their original order", () => {
    const editor = fromMarkdown("- first\n\n  > quote\n\n  - kid\n- sibling\n");

    backspaceAtStart(editor, [0, 0]);

    expect(slateToMarkdown(editor.children)).toBe(
      "first\n\n> quote\n\n* kid\n\n- sibling\n",
    );
  });

  it("keeps the block id, so references to the line still resolve", () => {
    const editor = fromMarkdown("- first ^abcdefghij\n");

    backspaceAtStart(editor, [0, 0]);

    expect(editor.children).toEqual([
      paragraph("first", { blockId: "abcdefghij" }),
    ]);
  });

  it("keeps a heading that leads the item", () => {
    const editor = fromMarkdown("- # title\n\n  body\n");

    backspaceAtStart(editor, [0, 0]);

    expect(slateToMarkdown(editor.children)).toBe("# title\n\nbody\n");
  });

  it("keeps the block id on a heading that leads the item", () => {
    const editor = fromMarkdown("- # title ^abcdefghij\n");

    backspaceAtStart(editor, [0, 0]);

    expect(editor.children[0]).toHaveProperty("blockId", "abcdefghij");
  });

  it("puts the caret at the start of the former lead", () => {
    const editor = fromMarkdown("- first\n\n  second\n");

    backspaceAtStart(editor, [0, 0]);

    expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });
  });
});
