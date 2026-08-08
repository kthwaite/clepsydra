import { createEditor, type Descendant } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { slateToMarkdown } from "#/editor/convert";
import { withInlinePunctuationBoundary } from "#/editor/plugins/withInlinePunctuationBoundary";
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
