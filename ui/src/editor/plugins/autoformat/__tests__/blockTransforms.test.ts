import { createEditor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { withOutliner } from "../../withOutliner";
import {
  tryBlockTransform,
  tryCodeFence,
  tryThematicBreak,
} from "../blockTransforms";

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

  it("[] + space in list-item -> checked:false (empty brackets)", () => {
    const editor = editorWithListItem("[]", 2);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const li = (editor.children[0] as any).children[0];
    expect(li.checked).toBe(false);
    expect(li.children[0].children[0].text).toBe("");
  });
});

describe("tryBlockTransform (paragraph -> task list)", () => {
  it("[] + space in paragraph -> bulleted-list with checked:false item", () => {
    const editor = editorWithParagraph("[]", 2);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const list = editor.children[0] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children[0].type).toBe("list-item");
    expect(list.children[0].checked).toBe(false);
  });

  it("[ ] + space in paragraph -> task list (checked:false)", () => {
    const editor = editorWithParagraph("[ ]", 3);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const list = editor.children[0] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children[0].checked).toBe(false);
  });

  it("[x] + space in paragraph -> task list (checked:true)", () => {
    const editor = editorWithParagraph("[x]", 3);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const list = editor.children[0] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children[0].checked).toBe(true);
  });

  it("[X] + space in paragraph -> task list (checked:true, uppercase)", () => {
    const editor = editorWithParagraph("[X]", 3);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const list = editor.children[0] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children[0].checked).toBe(true);
  });

  it("appends task shortcut to previous bulleted list", () => {
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
      { type: "paragraph", children: [{ text: "[]" }] },
    ];
    Transforms.select(editor, {
      anchor: { path: [1, 0], offset: 2 },
      focus: { path: [1, 0], offset: 2 },
    });
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    expect(editor.children.length).toBe(1);
    const list = editor.children[0] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children.length).toBe(2);
    expect(list.children[1].checked).toBe(false);
  });
});

describe("tryBlockTransform (trigger before existing text)", () => {
  it("## + space at the start of a non-empty line -> heading, text preserved", () => {
    const editor = editorWithParagraph("##hello world", 2);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const heading = editor.children[0] as any;
    expect(heading.type).toBe("heading");
    expect(heading.level).toBe(2);
    expect(heading.children[0].text).toBe("hello world");
  });

  it("leaves the cursor before the preserved text", () => {
    const editor = editorWithParagraph("#hello", 1);
    tryBlockTransform(editor);
    expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });
  });

  it("- + space at the start of a non-empty line -> bulleted list, text preserved", () => {
    const editor = editorWithParagraph("-milk", 1);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const list = editor.children[0] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children[0].children[0].children[0].text).toBe("milk");
  });

  it("> + space at the start of a non-empty line -> blockquote, text preserved", () => {
    const editor = editorWithParagraph(">quoted", 1);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const quote = editor.children[0] as any;
    expect(quote.type).toBe("blockquote");
    expect(quote.children[0].children[0].text).toBe("quoted");
  });

  it("[ ] + space at the start of a non-empty list item -> task, text preserved", () => {
    const editor = editorWithListItem("[ ]buy milk", 3);
    const result = tryBlockTransform(editor);
    expect(result).toBe(true);
    const li = (editor.children[0] as any).children[0];
    expect(li.checked).toBe(false);
    expect(li.children[0].children[0].text).toBe("buy milk");
  });

  it("does not transform when text precedes the trigger", () => {
    const editor = editorWithParagraph("a#hello", 2);
    expect(tryBlockTransform(editor)).toBe(false);
  });
});

describe("destructive conversions still require an empty remainder", () => {
  it("-- + `-` with trailing text does not become a thematic break", () => {
    const editor = editorWithParagraph("--rest", 2);
    expect(tryThematicBreak(editor)).toBe(false);
  });

  it("``` + Enter with trailing text does not become a code block", () => {
    const editor = editorWithParagraph("```rest", 3);
    expect(tryCodeFence(editor)).toBe(false);
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
