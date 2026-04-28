import { createEditor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { withOutliner } from "../../withOutliner";
import { tryBlockTransform, tryThematicBreak } from "../blockTransforms";

function editorWithParagraph(text: string, cursorOffset: number) {
  const editor = withOutliner(withHistory(createEditor()));
  editor.children = [{ type: "paragraph", children: [{ text }] }];
  Transforms.select(editor, {
    anchor: { path: [0, 0], offset: cursorOffset },
    focus: { path: [0, 0], offset: cursorOffset },
  });
  return editor;
}

function editorWithListItem(text: string, cursorOffset: number) {
  const editor = withOutliner(withHistory(createEditor()));
  editor.children = [
    {
      type: "bulleted-list",
      children: [
        {
          type: "list-item",
          children: [{ type: "paragraph", children: [{ text }] }],
        },
      ],
    },
  ];
  Transforms.select(editor, {
    anchor: { path: [0, 0, 0, 0], offset: cursorOffset },
    focus: { path: [0, 0, 0, 0], offset: cursorOffset },
  });
  return editor;
}

describe("tryBlockTransform (paragraph -> block)", () => {
  it("BT-01: # + space -> heading level 1", () => {
    const editor = editorWithParagraph("#", 1);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    expect((editor.children[0] as any).type).toBe("heading");
    expect((editor.children[0] as any).level).toBe(1);
  });

  it("BT-02: ###### + space -> heading level 6", () => {
    const editor = editorWithParagraph("######", 6);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    expect((editor.children[0] as any).type).toBe("heading");
    expect((editor.children[0] as any).level).toBe(6);
  });

  it("BT-03: 1. + space -> numbered list", () => {
    const editor = editorWithParagraph("1.", 2);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const list = editor.children[0] as any;
    expect(list.type).toBe("numbered-list");
    expect(list.children[0].type).toBe("list-item");
    expect(list.children[0].children[0].type).toBe("paragraph");
  });

  it("BT-04: - + space -> bulleted list", () => {
    const editor = editorWithParagraph("-", 1);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const list = editor.children[0] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children[0].type).toBe("list-item");
    expect(list.children[0].children[0].type).toBe("paragraph");
  });

  it("BT-04: * + space -> bulleted list", () => {
    const editor = editorWithParagraph("*", 1);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    expect((editor.children[0] as any).type).toBe("bulleted-list");
  });

  it("BT-05: > + space -> blockquote", () => {
    const editor = editorWithParagraph(">", 1);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    expect((editor.children[0] as any).type).toBe("blockquote");
    expect((editor.children[0] as any).children[0].type).toBe("paragraph");
  });

  it("does not transform non-paragraph blocks", () => {
    const editor = withOutliner(withHistory(createEditor()));
    editor.children = [
      { type: "heading", level: 1, children: [{ text: "#" }] },
    ];
    Transforms.select(editor, {
      anchor: { path: [0, 0], offset: 1 },
      focus: { path: [0, 0], offset: 1 },
    });
    const result = tryBlockTransform(editor);
    expect(result).toBe(false);
  });
});

describe("tryBlockTransform (list-item task promotion)", () => {
  it("BT-07: [ ] + space in list-item -> checked:false", () => {
    const editor = editorWithListItem("[ ]", 3);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const li = (editor.children[0] as any).children[0];
    expect(li.checked).toBe(false);
    expect(li.children[0].children[0].text).toBe("");
  });

  it("BT-08: [x] + space in list-item -> checked:true", () => {
    const editor = editorWithListItem("[x]", 3);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    expect((editor.children[0] as any).children[0].checked).toBe(true);
  });

  it("[X] + space -> checked:true (uppercase)", () => {
    const editor = editorWithListItem("[X]", 3);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    expect((editor.children[0] as any).children[0].checked).toBe(true);
  });
});

describe("tryThematicBreak", () => {
  it("BT-06: --- -> thematic break + trailing paragraph", () => {
    const editor = editorWithParagraph("--", 2);
    const result = tryThematicBreak(editor);
    expect(result).toBe(true);
    expect((editor.children[0] as any).type).toBe("thematic-break");
    expect((editor.children[1] as any).type).toBe("paragraph");
  });

  it("does not trigger on non-paragraph", () => {
    const editor = withOutliner(withHistory(createEditor()));
    editor.children = [
      { type: "heading", level: 1, children: [{ text: "--" }] },
    ];
    Transforms.select(editor, {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 2 },
    });
    const result = tryThematicBreak(editor);
    expect(result).toBe(false);
  });
});

describe("list merge policy", () => {
  it("appends to previous same-type list", () => {
    const editor = withOutliner(withHistory(createEditor()));
    editor.children = [
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [{ type: "paragraph", children: [{ text: "existing" }] }],
          },
        ],
      },
      { type: "paragraph", children: [{ text: "-" }] },
    ];
    Transforms.select(editor, {
      anchor: { path: [1, 0], offset: 1 },
      focus: { path: [1, 0], offset: 1 },
    });
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    expect(editor.children.length).toBe(1);
    expect((editor.children[0] as any).type).toBe("bulleted-list");
    expect((editor.children[0] as any).children.length).toBe(2);
  });
});
