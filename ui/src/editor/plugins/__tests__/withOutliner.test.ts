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

// ---------------------------------------------------------------------------
// deleteBackward at start of list-item
// ---------------------------------------------------------------------------

/**
 * Snapshot the editor's children, run normalization, and return whether the
 * tree changed. Used to assert that a transform leaves a normalized tree.
 */
function normalizeUnchanged(editor: Editor): boolean {
  const before = JSON.stringify(editor.children);
  Editor.normalize(editor, { force: true });
  const after = JSON.stringify(editor.children);
  return before === after;
}

/** Build a canonical list-item: list-item > paragraph > text. */
function canonicalItem(text: string, extra: object = {}) {
  return {
    type: "list-item" as const,
    ...extra,
    children: [{ type: "paragraph" as const, children: [{ text }] }],
  };
}

describe("deleteBackward at start of list-item", () => {
  it("unwraps a sole top-level item to a single paragraph, preserving text and shape", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [canonicalItem("Hello")],
      },
    ]);
    // Path: bulleted-list[0] > list-item[0] > paragraph[0] > text[0]
    selectAt(editor, [0, 0, 0, 0]);
    editor.deleteBackward("character");

    // (a) Tree shape: a single paragraph at top level with "Hello".
    expect(editor.children.length).toBe(1);
    const para = editor.children[0] as SlateElement & {
      children: { text: string }[];
    };
    expect(para.type).toBe("paragraph");
    expect(para.children.length).toBe(1);
    expect(para.children[0].text).toBe("Hello");

    // (b) Cursor sits at the start of the new paragraph.
    expect(editor.selection).not.toBeNull();
    expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });
    expect(editor.selection?.focus).toEqual({ path: [0, 0], offset: 0 });

    // (c) Normalize is satisfied — tree unchanged after force-normalize.
    expect(normalizeUnchanged(editor)).toBe(true);
  });

  it("outdents a nested list-item one level, preserving canonical shape", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "Parent" }] },
              {
                type: "bulleted-list",
                children: [canonicalItem("Child")],
              },
            ],
          },
        ],
      },
    ]);
    // Cursor at start of "Child":
    // root-list[0] > parent-li[0] > nested-list[1] > child-li[0] > paragraph[0] > text[0]
    selectAt(editor, [0, 0, 1, 0, 0, 0]);
    editor.deleteBackward("character");

    const list = topList(editor);
    // Two top-level items: Parent (now without its nested list), then Child.
    expect(list.children.length).toBe(2);
    const second = list.children[1] as SlateElement & {
      children: SlateElement[];
    };
    expect(second.type).toBe("list-item");
    // Canonical shape preserved: list-item > paragraph > text.
    const innerPara = second.children[0] as SlateElement & {
      children: { text: string }[];
    };
    expect(innerPara.type).toBe("paragraph");
    expect(innerPara.children[0].text).toBe("Child");

    // Normalize is satisfied.
    expect(normalizeUnchanged(editor)).toBe(true);
  });

  it("preserves list-above and inserts a paragraph after when no items follow", () => {
    // Mid-list with siblings BEFORE only.
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [canonicalItem("A"), canonicalItem("B"), canonicalItem("C")],
      },
    ]);
    // Cursor at start of "C" (last item) — paragraph path [0, 2, 0, 0].
    selectAt(editor, [0, 2, 0, 0]);
    editor.deleteBackward("character");

    // Shape: list[A, B] + paragraph(C). No trailing list.
    expect(editor.children.length).toBe(2);
    const list = editor.children[0] as SlateElement & {
      children: SlateElement[];
    };
    expect(list.type).toBe("bulleted-list");
    expect(list.children.length).toBe(2);
    const para = editor.children[1] as SlateElement & {
      children: { text: string }[];
    };
    expect(para.type).toBe("paragraph");
    expect(para.children[0].text).toBe("C");

    // Cursor at start of new paragraph.
    expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 });

    // Normalize is satisfied.
    expect(normalizeUnchanged(editor)).toBe(true);
  });

  it("preserves nested children when unwrapping a top-level parent item", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "Parent" }] },
              {
                type: "bulleted-list",
                children: [canonicalItem("Child")],
              },
            ],
          },
          canonicalItem("Sibling"),
        ],
      },
    ]);
    // Cursor at start of "Parent" — paragraph path [0, 0, 0, 0].
    selectAt(editor, [0, 0, 0, 0]);
    editor.deleteBackward("character");

    expect(editor.children.length).toBe(3);
    const para = editor.children[0] as SlateElement & {
      children: { text: string }[];
    };
    expect(para.type).toBe("paragraph");
    expect(para.children[0].text).toBe("Parent");

    const liftedChildren = editor.children[1] as SlateElement & {
      children: SlateElement[];
    };
    expect(liftedChildren.type).toBe("bulleted-list");
    const childPara = (liftedChildren.children[0] as SlateElement)
      .children[0] as SlateElement & { children: { text: string }[] };
    expect(childPara.children[0].text).toBe("Child");

    const trailing = editor.children[2] as SlateElement & {
      children: SlateElement[];
    };
    expect(trailing.type).toBe("bulleted-list");
    const siblingPara = (trailing.children[0] as SlateElement)
      .children[0] as SlateElement & { children: { text: string }[] };
    expect(siblingPara.children[0].text).toBe("Sibling");

    expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });
    expect(normalizeUnchanged(editor)).toBe(true);
  });

  it("inserts a paragraph and preserves the trailing list when no items precede", () => {
    // Mid-list with siblings AFTER only.
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [canonicalItem("A"), canonicalItem("B"), canonicalItem("C")],
      },
    ]);
    // Cursor at start of "A" (first item) — paragraph path [0, 0, 0, 0].
    selectAt(editor, [0, 0, 0, 0]);
    editor.deleteBackward("character");

    // Shape: paragraph(A) + list[B, C].
    expect(editor.children.length).toBe(2);
    const para = editor.children[0] as SlateElement & {
      children: { text: string }[];
    };
    expect(para.type).toBe("paragraph");
    expect(para.children[0].text).toBe("A");
    const trailing = editor.children[1] as SlateElement & {
      children: SlateElement[];
    };
    expect(trailing.type).toBe("bulleted-list");
    expect(trailing.children.length).toBe(2);
    const bItem = trailing.children[0] as SlateElement & {
      children: SlateElement[];
    };
    const bPara = bItem.children[0] as SlateElement & {
      children: { text: string }[];
    };
    expect(bPara.type).toBe("paragraph");
    expect(bPara.children[0].text).toBe("B");

    // Cursor at start of new paragraph (which replaced the old list at [0]).
    expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });

    // Normalize is satisfied.
    expect(normalizeUnchanged(editor)).toBe(true);
  });

  it("splits the list when a true mid-list item is unwrapped (siblings BOTH sides)", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [canonicalItem("A"), canonicalItem("B"), canonicalItem("C")],
      },
    ]);
    // Cursor at start of "B" — paragraph path [0, 1, 0, 0].
    selectAt(editor, [0, 1, 0, 0]);
    editor.deleteBackward("character");

    // Shape: list[A] + paragraph(B) + list[C].
    expect(editor.children.length).toBe(3);
    const above = editor.children[0] as SlateElement & {
      children: SlateElement[];
    };
    expect(above.type).toBe("bulleted-list");
    expect(above.children.length).toBe(1);
    const aPara = (above.children[0] as SlateElement)
      .children[0] as SlateElement & { children: { text: string }[] };
    expect(aPara.type).toBe("paragraph");
    expect(aPara.children[0].text).toBe("A");

    const para = editor.children[1] as SlateElement & {
      children: { text: string }[];
    };
    expect(para.type).toBe("paragraph");
    expect(para.children[0].text).toBe("B");

    const below = editor.children[2] as SlateElement & {
      children: SlateElement[];
    };
    expect(below.type).toBe("bulleted-list");
    expect(below.children.length).toBe(1);
    const cPara = (below.children[0] as SlateElement)
      .children[0] as SlateElement & { children: { text: string }[] };
    expect(cPara.type).toBe("paragraph");
    expect(cPara.children[0].text).toBe("C");

    // Cursor lives in the inserted paragraph at [1].
    expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 });

    // Normalize is satisfied.
    expect(normalizeUnchanged(editor)).toBe(true);
  });

  it("unwraps an empty list-item cleanly to a paragraph with a text child", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [canonicalItem("")],
      },
    ]);
    // Cursor inside the empty paragraph: [0, 0, 0, 0].
    selectAt(editor, [0, 0, 0, 0]);
    editor.deleteBackward("character");

    expect(editor.children.length).toBe(1);
    const para = editor.children[0] as SlateElement & {
      children: { text: string }[];
    };
    expect(para.type).toBe("paragraph");
    // Slate invariant: at least one text child.
    expect(para.children.length).toBeGreaterThanOrEqual(1);
    expect(para.children[0].text).toBe("");

    // Normalize is satisfied.
    expect(normalizeUnchanged(editor)).toBe(true);
  });

  it("falls through to default behaviour when cursor is mid-text in a list-item", () => {
    const editor = makeEditor([
      {
        type: "bulleted-list",
        children: [canonicalItem("Hello")],
      },
    ]);
    // Cursor at offset 3 (after "Hel"), path [0, 0, 0, 0].
    Transforms.select(editor, { path: [0, 0, 0, 0], offset: 3 });
    editor.deleteBackward("character");

    // Default behaviour: deletes one char, list structure preserved.
    const list = topList(editor);
    expect(list.type).toBe("bulleted-list");
    expect(list.children.length).toBe(1);
    const item = list.children[0] as SlateElement & {
      children: SlateElement[];
    };
    expect(item.type).toBe("list-item");
    const para = item.children[0] as SlateElement & {
      children: { text: string }[];
    };
    expect(para.type).toBe("paragraph");
    expect(para.children[0].text).toBe("Helo");

    // Normalize is satisfied.
    expect(normalizeUnchanged(editor)).toBe(true);
  });

  it("does nothing special when cursor is in a paragraph (not a list)", () => {
    const editor = makeEditor([
      { type: "paragraph", children: [{ text: "Hello" }] },
    ]);
    Transforms.select(editor, { path: [0, 0], offset: 1 });
    editor.deleteBackward("character");

    const para = editor.children[0] as SlateElement & {
      children: { text: string }[];
    };
    expect(para.children[0].text).toBe("ello");
  });
});
