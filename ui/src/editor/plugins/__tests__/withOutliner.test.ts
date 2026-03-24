import {
  createEditor,
  type Descendant,
  Editor,
  Element as SlateElement,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import {
  indentListItem,
  moveBlockDown,
  moveBlockUp,
  outdentListItem,
  toggleCheckbox,
  withOutliner,
} from "../withOutliner";

// Import types so module augmentation is active
import "../../types";

function makeEditor(nodes: Descendant[]) {
  const editor = withOutliner(withHistory(createEditor()));
  editor.children = nodes;
  Editor.normalize(editor, { force: true });
  return editor;
}

function selectAt(editor: Editor, path: number[]) {
  Transforms.select(editor, { path, offset: 0 });
}

/** Helper to get the top-level list element */
function topList(editor: Editor, index = 0) {
  return editor.children[index] as SlateElement & { children: SlateElement[] };
}

// ---------------------------------------------------------------------------
// indentListItem
// ---------------------------------------------------------------------------

describe("indentListItem", () => {
  it("indents a list item to become child of previous sibling", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          { type: "list-item", children: [{ text: "First" }] },
          { type: "list-item", children: [{ text: "Second" }] },
        ],
      },
    ]);
    selectAt(editor, [0, 1, 0]);
    indentListItem(editor);

    const list = topList(editor);
    // Only "First" at top level
    expect(list.children.length).toBe(1);
    const first = list.children[0] as SlateElement & {
      children: Descendant[];
    };
    // "First" should have text + nested list
    expect(first.children.length).toBe(2);
    const nested = first.children[1] as SlateElement & {
      children: SlateElement[];
    };
    expect(nested.type).toBe("bulleted-list");
    expect(nested.children.length).toBe(1);
    expect((nested.children[0] as SlateElement).type).toBe("list-item");
  });

  it("appends to existing nested list of previous sibling", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              { text: "First" },
              {
                type: "bulleted-list",
                children: [
                  { type: "list-item", children: [{ text: "Nested" }] },
                ],
              },
            ],
          },
          { type: "list-item", children: [{ text: "Second" }] },
        ],
      },
    ]);
    selectAt(editor, [0, 1, 0]);
    indentListItem(editor);

    const list = topList(editor);
    expect(list.children.length).toBe(1);
    const first = list.children[0] as SlateElement & {
      children: Descendant[];
    };
    const nested = first.children[1] as SlateElement & {
      children: SlateElement[];
    };
    expect(nested.type).toBe("bulleted-list");
    // Should now have "Nested" and "Second"
    expect(nested.children.length).toBe(2);
  });

  it("preserves numbered-list type when indenting", () => {
    const editor = makeEditor([
      {
        type: "numbered-list",
        children: [
          { type: "list-item", children: [{ text: "One" }] },
          { type: "list-item", children: [{ text: "Two" }] },
        ],
      },
    ]);
    selectAt(editor, [0, 1, 0]);
    indentListItem(editor);

    const list = topList(editor);
    const first = list.children[0] as SlateElement & {
      children: Descendant[];
    };
    const nested = first.children[1] as SlateElement;
    expect(nested.type).toBe("numbered-list");
  });

  it("does nothing when item has no previous sibling", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [{ type: "list-item", children: [{ text: "Only" }] }],
      },
    ]);
    selectAt(editor, [0, 0, 0]);
    indentListItem(editor);

    const list = topList(editor);
    expect(list.children.length).toBe(1);
  });

  it("does nothing when selection is not in a list item", () => {
    const editor = makeEditor([
      { type: "paragraph", children: [{ text: "Not a list" }] },
    ]);
    selectAt(editor, [0, 0]);
    indentListItem(editor);

    expect((editor.children[0] as SlateElement).type).toBe("paragraph");
  });
});

// ---------------------------------------------------------------------------
// outdentListItem
// ---------------------------------------------------------------------------

describe("outdentListItem", () => {
  it("outdents a nested list item to be a sibling of the grandparent", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              { text: "Parent" },
              {
                type: "bulleted-list",
                children: [
                  { type: "list-item", children: [{ text: "Child" }] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    // Select inside "Child" — path: [0, 0, 1, 0, 0]
    // root-list[0] > li[0] > nested-list[1] > li[0] > text[0]
    selectAt(editor, [0, 0, 1, 0, 0]);
    outdentListItem(editor);

    const list = topList(editor);
    // Should now have two top-level items: "Parent" and "Child"
    expect(list.children.length).toBe(2);
    const second = list.children[1] as SlateElement & {
      children: Descendant[];
    };
    expect(second.type).toBe("list-item");
  });

  it("does nothing for a top-level list item", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [{ type: "list-item", children: [{ text: "Top" }] }],
      },
    ]);
    selectAt(editor, [0, 0, 0]);
    outdentListItem(editor);

    const list = topList(editor);
    expect(list.children.length).toBe(1);
  });

  it("carries trailing siblings as a nested list of the outdented item", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              { text: "Parent" },
              {
                type: "bulleted-list",
                children: [
                  { type: "list-item", children: [{ text: "A" }] },
                  { type: "list-item", children: [{ text: "B" }] },
                  { type: "list-item", children: [{ text: "C" }] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    // Select inside "A" — [0, 0, 1, 0, 0]
    selectAt(editor, [0, 0, 1, 0, 0]);
    outdentListItem(editor);

    const list = topList(editor);
    // "Parent" and "A" should be top-level siblings
    expect(list.children.length).toBe(2);

    // "A" should carry B and C as its nested list
    const aItem = list.children[1] as SlateElement & {
      children: Descendant[];
    };
    expect(aItem.type).toBe("list-item");
    // Should have text + nested list
    expect(aItem.children.length).toBe(2);
    const nestedInA = aItem.children[1] as SlateElement & {
      children: SlateElement[];
    };
    expect(nestedInA.type).toBe("bulleted-list");
    expect(nestedInA.children.length).toBe(2); // B and C
  });
});

// ---------------------------------------------------------------------------
// moveBlockUp
// ---------------------------------------------------------------------------

describe("moveBlockUp", () => {
  it("swaps list item with previous sibling", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          { type: "list-item", children: [{ text: "A" }] },
          { type: "list-item", children: [{ text: "B" }] },
          { type: "list-item", children: [{ text: "C" }] },
        ],
      },
    ]);
    // Select "B"
    selectAt(editor, [0, 1, 0]);
    moveBlockUp(editor);

    const list = topList(editor);
    const texts = list.children.map(
      (li) => ((li as SlateElement).children[0] as { text: string }).text,
    );
    expect(texts).toEqual(["B", "A", "C"]);
  });

  it("does nothing when item is first", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          { type: "list-item", children: [{ text: "First" }] },
          { type: "list-item", children: [{ text: "Second" }] },
        ],
      },
    ]);
    selectAt(editor, [0, 0, 0]);
    moveBlockUp(editor);

    const list = topList(editor);
    const texts = list.children.map(
      (li) => ((li as SlateElement).children[0] as { text: string }).text,
    );
    expect(texts).toEqual(["First", "Second"]);
  });

  it("does nothing when not in a list item", () => {
    const editor = makeEditor([
      { type: "paragraph", children: [{ text: "Hello" }] },
    ]);
    selectAt(editor, [0, 0]);
    moveBlockUp(editor);

    expect(
      ((editor.children[0] as SlateElement).children[0] as { text: string })
        .text,
    ).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// moveBlockDown
// ---------------------------------------------------------------------------

describe("moveBlockDown", () => {
  it("swaps list item with next sibling", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          { type: "list-item", children: [{ text: "A" }] },
          { type: "list-item", children: [{ text: "B" }] },
          { type: "list-item", children: [{ text: "C" }] },
        ],
      },
    ]);
    // Select "B"
    selectAt(editor, [0, 1, 0]);
    moveBlockDown(editor);

    const list = topList(editor);
    const texts = list.children.map(
      (li) => ((li as SlateElement).children[0] as { text: string }).text,
    );
    expect(texts).toEqual(["A", "C", "B"]);
  });

  it("does nothing when item is last", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          { type: "list-item", children: [{ text: "First" }] },
          { type: "list-item", children: [{ text: "Last" }] },
        ],
      },
    ]);
    selectAt(editor, [0, 1, 0]);
    moveBlockDown(editor);

    const list = topList(editor);
    const texts = list.children.map(
      (li) => ((li as SlateElement).children[0] as { text: string }).text,
    );
    expect(texts).toEqual(["First", "Last"]);
  });

  it("does nothing when not in a list item", () => {
    const editor = makeEditor([
      { type: "paragraph", children: [{ text: "Hello" }] },
    ]);
    selectAt(editor, [0, 0]);
    moveBlockDown(editor);

    expect(
      ((editor.children[0] as SlateElement).children[0] as { text: string })
        .text,
    ).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// toggleCheckbox
// ---------------------------------------------------------------------------

describe("toggleCheckbox", () => {
  it("adds checked: false to non-task item", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [{ type: "list-item", children: [{ text: "Item" }] }],
      },
    ]);
    selectAt(editor, [0, 0, 0]);
    toggleCheckbox(editor);

    const item = topList(editor).children[0] as SlateElement & {
      checked?: boolean | null;
    };
    expect(item.checked).toBe(false);
  });

  it("toggles false to true", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            checked: false,
            children: [{ text: "Todo" }],
          },
        ],
      },
    ]);
    selectAt(editor, [0, 0, 0]);
    toggleCheckbox(editor);

    const item = topList(editor).children[0] as SlateElement & {
      checked?: boolean | null;
    };
    expect(item.checked).toBe(true);
  });

  it("toggles true to false", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            checked: true,
            children: [{ text: "Done" }],
          },
        ],
      },
    ]);
    selectAt(editor, [0, 0, 0]);
    toggleCheckbox(editor);

    const item = topList(editor).children[0] as SlateElement & {
      checked?: boolean | null;
    };
    expect(item.checked).toBe(false);
  });

  it("does nothing when not in a list item", () => {
    const editor = makeEditor([
      { type: "paragraph", children: [{ text: "Not a list" }] },
    ]);
    selectAt(editor, [0, 0]);
    toggleCheckbox(editor);

    expect((editor.children[0] as SlateElement).type).toBe("paragraph");
  });
});

describe("withOutliner empty-children fallback", () => {
  it("inserts paragraph child (not bare text) into empty list-item", () => {
    const editor = withOutliner(withHistory(createEditor()));
    editor.children = [
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [],
          },
        ],
      },
    ] as any;
    Editor.normalize(editor, { force: true });

    const listItem = (editor.children[0] as any).children[0];
    expect(listItem.children.length).toBeGreaterThanOrEqual(1);
    const firstChild = listItem.children[0];
    expect(SlateElement.isElement(firstChild)).toBe(true);
    expect((firstChild as any).type).toBe("paragraph");
  });
});
