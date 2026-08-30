import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { moveToAdjacentCell, withTables } from "#/editor/plugins/withTables";
import { makeWikilink } from "#/editor/schema/elements/wikilink";
import { withSchema } from "#/editor/schema/withSchema";

function tableValue(): Descendant[] {
  return [
    {
      type: "table",
      children: [
        {
          type: "table-row",
          children: [
            { type: "table-cell", header: true, children: [{ text: "A" }] },
            { type: "table-cell", header: true, children: [{ text: "B" }] },
          ],
        },
        {
          type: "table-row",
          children: [
            { type: "table-cell", children: [{ text: "1" }] },
            { type: "table-cell", children: [{ text: "2" }] },
          ],
        },
      ],
    },
    { type: "paragraph", children: [{ text: "after" }] },
  ] as unknown as Descendant[];
}

function tableEditor() {
  const editor = withTables(withSchema(createEditor()));
  editor.children = tableValue();
  return editor;
}

/** Path of a cell in the fixture: [table, row, cell]. */
function cellPath(row: number, cell: number) {
  return [0, row, cell];
}

function boundaryEditor(text: string) {
  const editor = withHistory(withTables(withSchema(createEditor())));
  editor.children = [
    { type: "paragraph", children: [{ text }] },
    tableValue()[0],
    { type: "paragraph", children: [{ text: "after" }] },
  ] as Descendant[];
  return editor;
}

describe("withTables", () => {
  it("refuses Enter inside a cell so the cell is never split", () => {
    const editor = tableEditor();
    Transforms.select(editor, Editor.end(editor, cellPath(0, 0)));
    editor.insertBreak();

    const rows = (
      editor.children[0] as unknown as { children: { children: unknown[] }[] }
    ).children;
    expect(rows).toHaveLength(2);
    expect(rows[0].children).toHaveLength(2);
  });

  it("still breaks a paragraph outside the table", () => {
    const editor = tableEditor();
    Transforms.select(editor, Editor.end(editor, [1]));
    editor.insertBreak();
    expect(editor.children).toHaveLength(3);
  });

  it("refuses a backspace at the start of a cell so cells never merge", () => {
    const editor = tableEditor();
    Transforms.select(editor, Editor.start(editor, cellPath(0, 1)));
    editor.deleteBackward("character");

    const cells = (
      editor.children[0] as unknown as {
        children: { children: unknown[] }[];
      }
    ).children[0].children;
    expect(cells).toHaveLength(2);
    expect(Editor.string(editor, cellPath(0, 0))).toBe("A");
  });

  it("still deletes inside a cell", () => {
    const editor = tableEditor();
    Transforms.select(editor, Editor.end(editor, cellPath(0, 0)));
    editor.deleteBackward("character");
    expect(Editor.string(editor, cellPath(0, 0))).toBe("");
  });

  it("refuses a forward delete at the end of a cell", () => {
    const editor = tableEditor();
    Transforms.select(editor, Editor.end(editor, cellPath(0, 0)));
    editor.deleteForward("character");
    expect(Editor.string(editor, cellPath(0, 1))).toBe("B");
  });

  it("removes an empty block before a table without changing the table", () => {
    const editor = boundaryEditor("");
    const originalTable = structuredClone(editor.children[1]);
    Transforms.select(editor, Editor.end(editor, [0]));

    editor.deleteForward("character");

    expect(editor.children).toEqual([
      originalTable,
      { type: "paragraph", children: [{ text: "after" }] },
    ]);
    expect(editor.selection).toEqual({
      anchor: { path: [0, 0, 0, 0], offset: 0 },
      focus: { path: [0, 0, 0, 0], offset: 0 },
    });

    HistoryEditor.undo(editor);
    expect(editor.children).toEqual([
      { type: "paragraph", children: [{ text: "" }] },
      originalTable,
      { type: "paragraph", children: [{ text: "after" }] },
    ]);
    expect(editor.history.undos).toHaveLength(0);
  });

  it("does nothing at the end of a non-empty block before a table", () => {
    const editor = boundaryEditor("before");
    const originalChildren = structuredClone(editor.children);
    Transforms.select(editor, Editor.end(editor, [0]));
    const originalSelection = structuredClone(editor.selection);

    editor.deleteForward("character");

    expect(editor.children).toEqual(originalChildren);
    expect(editor.selection).toEqual(originalSelection);
  });
  it("preserves an inline-void-only block before a table", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [
      {
        type: "paragraph",
        children: [
          { text: "" },
          makeWikilink({ target: "Meaningful content" }),
          { text: "" },
        ],
      },
      tableValue()[0],
      { type: "paragraph", children: [{ text: "after" }] },
    ] as Descendant[];
    Transforms.select(editor, Editor.end(editor, [0]));
    const originalChildren = structuredClone(editor.children);
    const originalSelection = structuredClone(editor.selection);

    editor.deleteForward("character");

    expect(editor.children).toEqual(originalChildren);
    expect(editor.selection).toEqual(originalSelection);
  });

  it("delegates an ordinary forward delete outside a table boundary", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [
      { type: "paragraph", children: [{ text: "abc" }] },
      { type: "paragraph", children: [{ text: "after" }] },
    ] as Descendant[];
    Transforms.select(editor, { path: [0, 0], offset: 1 });

    editor.deleteForward("character");

    expect(Editor.string(editor, [0])).toBe("ac");
  });

  it("moves the caret to the next cell, wrapping to the next row", () => {
    const editor = tableEditor();
    Transforms.select(editor, Editor.end(editor, cellPath(0, 1)));

    expect(moveToAdjacentCell(editor, "next")).toBe(true);
    expect(editor.selection?.anchor.path.slice(0, 3)).toEqual(cellPath(1, 0));
  });

  it("moves the caret to the previous cell, wrapping to the previous row", () => {
    const editor = tableEditor();
    Transforms.select(editor, Editor.start(editor, cellPath(1, 0)));

    expect(moveToAdjacentCell(editor, "previous")).toBe(true);
    expect(editor.selection?.anchor.path.slice(0, 3)).toEqual(cellPath(0, 1));
  });

  it("declines to move past the last cell", () => {
    const editor = tableEditor();
    Transforms.select(editor, Editor.end(editor, cellPath(1, 1)));
    expect(moveToAdjacentCell(editor, "next")).toBe(false);
  });

  it("declines to move when the selection is outside a table", () => {
    const editor = tableEditor();
    Transforms.select(editor, Editor.start(editor, [1]));
    expect(moveToAdjacentCell(editor, "next")).toBe(false);
  });
});
