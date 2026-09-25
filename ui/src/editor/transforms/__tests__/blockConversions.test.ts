import { createEditor } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { applyBlockConversion } from "../blockConversions";

function editorWithParagraph(text: string) {
  const editor = withOutliner(withHistory(createEditor()));
  editor.children = [{ type: "paragraph", children: [{ text }] }];
  return editor;
}

function triggerRange(len: number) {
  return {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: len },
  };
}

describe("applyBlockConversion", () => {
  it("BC-01: heading sets type + level and deletes trigger", () => {
    const editor = editorWithParagraph("##");
    applyBlockConversion(editor, {
      at: [0],
      deleteRange: triggerRange(2),
      conversion: { type: "heading", level: 2 },
    });
    const node = editor.children[0];
    expect(node).toHaveProperty("type", "heading");
    expect(node).toHaveProperty("level", 2);
    expect(node).toHaveProperty("children.0.text", "");
  });

  it("BC-02: bulleted-list wraps paragraph in list-item > paragraph", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, {
      at: [0],
      conversion: { type: "bulleted-list" },
    });
    const list = editor.children[0];
    expect(list).toHaveProperty("type", "bulleted-list");
    expect(list).toHaveProperty("children.0.type", "list-item");
    expect(list).toHaveProperty("children.0.children.0.type", "paragraph");
  });

  it("BC-03: numbered-list produces an ordered list", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, {
      at: [0],
      conversion: { type: "numbered-list" },
    });
    expect(editor.children[0]).toHaveProperty("type", "numbered-list");
  });

  it("BC-04: task produces a bulleted list-item with checked: false", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, { at: [0], conversion: { type: "task" } });
    const list = editor.children[0];
    expect(list).toHaveProperty("type", "bulleted-list");
    expect(list).toHaveProperty("children.0.checked", false);
  });

  it("BC-04b: task with checked: true produces a checked item", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, {
      at: [0],
      conversion: { type: "task", checked: true },
    });
    const list = editor.children[0];
    expect(list).toHaveProperty("children.0.checked", true);
  });

  it("BC-05: blockquote wraps the paragraph", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, {
      at: [0],
      conversion: { type: "blockquote" },
    });
    const bq = editor.children[0];
    expect(bq).toHaveProperty("type", "blockquote");
    expect(bq).toHaveProperty("children.0.type", "paragraph");
  });

  it("BC-06: code-block sets type and language", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, {
      at: [0],
      conversion: { type: "code-block", language: "rust" },
    });
    const cb = editor.children[0];
    expect(cb).toHaveProperty("type", "code-block");
    expect(cb).toHaveProperty("language", "rust");
  });

  it("BC-07: thematic-break sets type and inserts a trailing paragraph", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, {
      at: [0],
      conversion: { type: "thematic-break" },
    });
    expect(editor.children[0]).toHaveProperty("type", "thematic-break");
    expect(editor.children[1]).toHaveProperty("type", "paragraph");
  });

  it("BC-08: a new bulleted-list merges with the adjacent list above", () => {
    const editor = withOutliner(withHistory(createEditor()));
    editor.children = [
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [{ type: "paragraph", children: [{ text: "a" }] }],
          },
        ],
      },
      { type: "paragraph", children: [{ text: "" }] },
    ];
    applyBlockConversion(editor, {
      at: [1],
      conversion: { type: "bulleted-list" },
    });
    expect(editor.children).toHaveLength(1);
    const list = editor.children[0];
    expect(list).toHaveProperty("type", "bulleted-list");
    expect(list).toHaveProperty("children.length", 2);
  });

  it("BC-09: slash-style delete + convert merges with the adjacent list above", () => {
    // Mirrors the slash-menu flow: a `/bullet` query paragraph sits below an
    // existing list; the deleteRange removes the query, then the new list
    // merges into the one above. The existing item stays first; the new
    // (now-empty) item is appended after it.
    const editor = withOutliner(withHistory(createEditor()));
    editor.children = [
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [{ type: "paragraph", children: [{ text: "a" }] }],
          },
        ],
      },
      { type: "paragraph", children: [{ text: "/bullet" }] },
    ];
    applyBlockConversion(editor, {
      at: [1],
      deleteRange: {
        anchor: { path: [1, 0], offset: 0 },
        focus: { path: [1, 0], offset: "/bullet".length },
      },
      conversion: { type: "bulleted-list" },
    });
    expect(editor.children).toHaveLength(1);
    const list = editor.children[0];
    expect(list).toHaveProperty("children.length", 2);
    expect(list).toHaveProperty("children.0.children.0.children.0.text", "a");
    expect(list).toHaveProperty("children.1.children.0.children.0.text", "");
  });
});
