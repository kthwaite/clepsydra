import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { slateToMarkdown } from "#/editor/convert";
import {
  exitTerminalInlineCode,
  withInlinePunctuationBoundary,
} from "#/editor/plugins/withInlinePunctuationBoundary";
import { withSchema } from "#/editor/schema/withSchema";

function makeEditor(children: Descendant[]) {
  const configured = withInlinePunctuationBoundary(
    withSchema(withHistory(createEditor())),
  );
  configured.children = children;
  return configured;
}

const punctuationCases = [
  [",", "[label](https://example.test),", "**bold**, plain"],
  [".", "[label](https://example.test).", "**bold**. plain"],
  [";", "[label](https://example.test);", "**bold**; plain"],
  [":", "[label](https://example.test):", "**bold**: plain"],
  ["!", "[label](https://example.test)!", "**bold**! plain"],
  ["?", "[label](https://example.test)?", "**bold**? plain"],
] as const;

describe("withInlinePunctuationBoundary", () => {
  it.each(punctuationCases)(
    "places %s after a link when inserted at its end",
    (punctuation, expected) => {
      const editor = makeEditor([
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "https://example.test",
              children: [{ text: "label" }],
            },
            { text: "" },
          ],
        },
      ]);
      editor.selection = {
        anchor: { path: [0, 0, 0], offset: 5 },
        focus: { path: [0, 0, 0], offset: 5 },
      };

      editor.insertText(punctuation);

      expect(slateToMarkdown(editor.children).trim()).toBe(expected);
    },
  );

  it.each(punctuationCases)(
    "clears a bold mark before inserting %s",
    (punctuation, _linkExpected, expected) => {
      const editor = makeEditor([
        {
          type: "paragraph",
          children: [{ text: "bold", bold: true }, { text: " plain" }],
        },
      ]);
      editor.selection = {
        anchor: { path: [0, 0], offset: 4 },
        focus: { path: [0, 0], offset: 4 },
      };

      editor.insertText(punctuation);

      expect(slateToMarkdown(editor.children).trim()).toBe(expected);
    },
  );

  it.each([
    ["bold", { bold: true }, "**bo,ld**"],
    ["italic", { italic: true }, "*it,alic*"],
  ] as const)(
    "keeps punctuation %s when inserted in the middle of a marked leaf",
    (_mark, leafMarks, expected) => {
      const editor = makeEditor([
        {
          type: "paragraph",
          children: [{ text: _mark, ...leafMarks }],
        },
      ]);
      editor.selection = {
        anchor: { path: [0, 0], offset: 2 },
        focus: { path: [0, 0], offset: 2 },
      };

      editor.insertText(",");

      expect(slateToMarkdown(editor.children).trim()).toBe(expected);
    },
  );

  it("keeps an explicitly active mark away from a leaf boundary", () => {
    const editor = makeEditor([
      {
        type: "paragraph",
        children: [{ text: "plain" }],
      },
    ]);
    editor.selection = {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 2 },
    };
    editor.addMark("bold", true);

    editor.insertText(",");

    expect(editor.children).toEqual([
      {
        type: "paragraph",
        children: [{ text: "pl" }, { text: ",", bold: true }, { text: "ain" }],
      },
    ]);
  });

  it("keeps punctuation inside a link when inserted before its end", () => {
    const editor = makeEditor([
      {
        type: "paragraph",
        children: [
          { text: "" },
          {
            type: "link",
            url: "https://example.test",
            children: [{ text: "label" }],
          },
          { text: "" },
        ],
      },
    ]);
    editor.selection = {
      anchor: { path: [0, 1, 0], offset: 3 },
      focus: { path: [0, 1, 0], offset: 3 },
    };

    editor.insertText(",");

    expect(slateToMarkdown(editor.children).trim()).toBe(
      "[lab,el](https://example.test)",
    );
  });

  it("keeps a normal letter inside a link when inserted at its end", () => {
    const editor = makeEditor([
      {
        type: "paragraph",
        children: [
          { text: "" },
          {
            type: "link",
            url: "https://example.test",
            children: [{ text: "label" }],
          },
          { text: "" },
        ],
      },
    ]);
    editor.selection = {
      anchor: { path: [0, 1, 0], offset: 5 },
      focus: { path: [0, 1, 0], offset: 5 },
    };

    editor.insertText("x");

    expect(slateToMarkdown(editor.children).trim()).toBe(
      "[labelx](https://example.test)",
    );
  });
});

describe("exitTerminalInlineCode", () => {
  it("exits a terminal inline-code leaf before the next insertion", () => {
    const editor = makeEditor([
      {
        type: "paragraph",
        children: [{ text: "code", code: true }],
      },
    ]);
    Transforms.select(editor, { path: [0, 0], offset: 4 });

    expect(exitTerminalInlineCode(editor)).toBe(true);
    expect(exitTerminalInlineCode(editor)).toBe(false);
    editor.insertText(" next");

    expect(slateToMarkdown(editor.children).trim()).toBe("`code` next");
  });

  it("does not exit from inside an inline-code leaf", () => {
    const editor = makeEditor([
      {
        type: "paragraph",
        children: [{ text: "code", code: true }],
      },
    ]);
    Transforms.select(editor, { path: [0, 0], offset: 2 });

    expect(exitTerminalInlineCode(editor)).toBe(false);
    editor.insertText("X");

    expect(slateToMarkdown(editor.children).trim()).toBe("`coXde`");
  });

  it("does not exit inline code when ordinary text follows it", () => {
    const editor = makeEditor([
      {
        type: "paragraph",
        children: [{ text: "code", code: true }, { text: " follows" }],
      },
    ]);
    Transforms.select(editor, { path: [0, 0], offset: 4 });

    expect(exitTerminalInlineCode(editor)).toBe(false);
    editor.insertText("X");

    expect(slateToMarkdown(editor.children).trim()).toBe("`codeX` follows");
  });

  it("does not exit terminal text without the code mark", () => {
    const editor = makeEditor([
      {
        type: "paragraph",
        children: [{ text: "plain" }],
      },
    ]);
    Transforms.select(editor, { path: [0, 0], offset: 5 });

    expect(exitTerminalInlineCode(editor)).toBe(false);
    editor.insertText(" text");

    expect(slateToMarkdown(editor.children).trim()).toBe("plain text");
  });

  it("does not exit inline code for an expanded selection", () => {
    const editor = makeEditor([
      {
        type: "paragraph",
        children: [{ text: "code", code: true }],
      },
    ]);
    Transforms.select(editor, {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 4 },
    });

    expect(exitTerminalInlineCode(editor)).toBe(false);

    expect(editor.selection).toEqual({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 4 },
    });
  });

  it("does not exit from a code block", () => {
    const editor = makeEditor([
      {
        type: "code-block",
        language: "typescript",
        children: [{ text: "code", code: true }],
      },
    ]);
    Transforms.select(editor, { path: [0, 0], offset: 4 });

    expect(exitTerminalInlineCode(editor)).toBe(false);
    editor.insertText(" next");

    expect(slateToMarkdown(editor.children).trim()).toBe(
      "```typescript\ncode next\n```",
    );
  });

  it("removes only code from a terminal leaf with mixed marks", () => {
    const editor = makeEditor([
      {
        type: "paragraph",
        children: [{ text: "code", code: true, bold: true }],
      },
    ]);
    Transforms.select(editor, { path: [0, 0], offset: 4 });

    expect(exitTerminalInlineCode(editor)).toBe(true);
    expect(Editor.marks(editor)).toEqual({ bold: true });

    editor.insertText(" bold");
    expect(slateToMarkdown(editor.children).trim()).toBe(
      "`code`**&#x20;bold**",
    );
  });
});
