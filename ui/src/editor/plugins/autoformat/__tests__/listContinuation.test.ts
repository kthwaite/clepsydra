import { createEditor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { withOutliner } from "../../withOutliner";
import { tryListContinuation } from "../listContinuation";

// Import types so module augmentation is active
import "../../../types";

import type { ListItemElement } from "../../../types";

function makeListEditor(
  items: ListItemElement[],
  listType: "bulleted-list" | "numbered-list" = "bulleted-list",
) {
  const editor = withOutliner(withHistory(createEditor()));
  editor.children = [
    {
      type: listType,
      children: items,
    },
  ];
  return editor;
}

describe("tryListContinuation", () => {
  it("LC-01: Enter in non-empty item creates next item with canonical shape", () => {
    const editor = makeListEditor([
      {
        type: "list-item",
        children: [{ type: "paragraph", children: [{ text: "hello" }] }],
      },
    ]);
    Transforms.select(editor, {
      anchor: { path: [0, 0, 0, 0], offset: 5 },
      focus: { path: [0, 0, 0, 0], offset: 5 },
    });
    const result = tryListContinuation(editor);
    expect(result).toBe(true);
    const list = editor.children[0] as any;
    expect(list.children.length).toBe(2);
    const newItem = list.children[1];
    expect(newItem.type).toBe("list-item");
    expect(newItem.children[0].type).toBe("paragraph");
    expect(newItem.children[0].children[0].text).toBe("");
  });

  it("LC-02: Enter in non-empty task item creates checked:false next item", () => {
    const editor = makeListEditor([
      {
        type: "list-item",
        checked: true,
        children: [{ type: "paragraph", children: [{ text: "done" }] }],
      },
    ]);
    Transforms.select(editor, {
      anchor: { path: [0, 0, 0, 0], offset: 4 },
      focus: { path: [0, 0, 0, 0], offset: 4 },
    });
    const result = tryListContinuation(editor);
    expect(result).toBe(true);
    const newItem = (editor.children[0] as any).children[1];
    expect(newItem.checked).toBe(false);
  });

  it("LC-04: Enter on empty top-level item exits to paragraph", () => {
    const editor = makeListEditor([
      {
        type: "list-item",
        children: [{ type: "paragraph", children: [{ text: "first" }] }],
      },
      {
        type: "list-item",
        children: [{ type: "paragraph", children: [{ text: "" }] }],
      },
    ]);
    Transforms.select(editor, {
      anchor: { path: [0, 1, 0, 0], offset: 0 },
      focus: { path: [0, 1, 0, 0], offset: 0 },
    });
    const result = tryListContinuation(editor);
    expect(result).toBe(true);
    expect((editor.children[0] as any).type).toBe("bulleted-list");
    expect((editor.children[0] as any).children.length).toBe(1);
    expect((editor.children[1] as any).type).toBe("paragraph");
  });

  it("LC-03: Enter on empty nested item outdents", () => {
    const editor = withOutliner(withHistory(createEditor()));
    editor.children = [
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "parent" }] },
              {
                type: "bulleted-list",
                children: [
                  {
                    type: "list-item",
                    children: [{ type: "paragraph", children: [{ text: "" }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    Transforms.select(editor, {
      anchor: { path: [0, 0, 1, 0, 0, 0], offset: 0 },
      focus: { path: [0, 0, 1, 0, 0, 0], offset: 0 },
    });
    const result = tryListContinuation(editor);
    expect(result).toBe(true);
    const list = editor.children[0] as any;
    expect(list.children.length).toBe(2);
  });

  it("LC-05: Enter mid-item splits text", () => {
    const editor = makeListEditor([
      {
        type: "list-item",
        children: [{ type: "paragraph", children: [{ text: "hello world" }] }],
      },
    ]);
    Transforms.select(editor, {
      anchor: { path: [0, 0, 0, 0], offset: 5 },
      focus: { path: [0, 0, 0, 0], offset: 5 },
    });
    const result = tryListContinuation(editor);
    expect(result).toBe(true);
    const list = editor.children[0] as any;
    expect(list.children.length).toBe(2);
    expect(list.children[0].children[0].children[0].text).toBe("hello");
    expect(list.children[1].children[0].children[0].text).toBe(" world");
  });
});
