import { createEditor, Editor, Node, Element as SlateElement } from "slate";
import { describe, expect, it } from "vitest";
import { withTables } from "#/editor/plugins/withTables";
import {
  makeTable,
  makeTableCell,
  makeTableRow,
} from "#/editor/schema/elements/table";
import type { TableElement } from "#/editor/schema/types";
import { withSchema } from "#/editor/schema/withSchema";
import {
  appendTableColumn,
  appendTableRow,
  createTableGrid,
  deleteTableColumn,
  deleteTableRow,
  dropBoundary,
  duplicateTableColumn,
  duplicateTableRow,
  insertTableColumn,
  insertTableRow,
  moveTableColumn,
  moveTableRow,
  moveTarget,
  setTableColumnAlign,
  sortTableByColumn,
} from "../table";

function alignedTable(): TableElement {
  return makeTable({
    align: ["left", "right"],
    children: [
      makeTableRow({
        children: [
          makeTableCell({
            header: true,
            align: "left",
            children: [{ text: "A" }],
          }),
          makeTableCell({
            header: true,
            align: "right",
            children: [{ text: "B" }],
          }),
        ],
      }),
      makeTableRow({
        children: [
          makeTableCell({ align: "left", children: [{ text: "1" }] }),
          makeTableCell({ align: "right", children: [{ text: "2" }] }),
        ],
      }),
    ],
  });
}

function threeByThreeTable(): TableElement {
  return makeTable({
    align: ["left", "center", "right"],
    children: [
      makeTableRow({
        children: [
          makeTableCell({ header: true, children: [{ text: "A" }] }),
          makeTableCell({ header: true, children: [{ text: "B" }] }),
          makeTableCell({ header: true, children: [{ text: "C" }] }),
        ],
      }),
      makeTableRow({
        children: [
          makeTableCell({ children: [{ text: "1" }] }),
          makeTableCell({ children: [{ text: "2" }] }),
          makeTableCell({ children: [{ text: "3" }] }),
        ],
      }),
      makeTableRow({
        children: [
          makeTableCell({ children: [{ text: "4" }] }),
          makeTableCell({ children: [{ text: "5" }] }),
          makeTableCell({ children: [{ text: "6" }] }),
        ],
      }),
    ],
  });
}

function editorWithTable() {
  const editor = withTables(withSchema(createEditor()));
  editor.children = [alignedTable()];
  return editor;
}

function firstTable(editor: Editor): TableElement {
  const node = editor.children[0];
  if (!SlateElement.isElement(node) || node.type !== "table") {
    throw new Error("Expected the editor's first node to be a table");
  }
  return node;
}

describe("table transforms", () => {
  it("creates a 3x3 grid with a header row and empty cells", () => {
    const table = createTableGrid({ columns: 3, rows: 3 });

    expect(table.type).toBe("table");
    expect(table.children.map((row) => row.type)).toEqual([
      "table-row",
      "table-row",
      "table-row",
    ]);
    expect(table.children.map((row) => row.children.length)).toEqual([3, 3, 3]);
    expect(
      table.children.map((row) => row.children.map((cell) => cell.type)),
    ).toEqual([
      ["table-cell", "table-cell", "table-cell"],
      ["table-cell", "table-cell", "table-cell"],
      ["table-cell", "table-cell", "table-cell"],
    ]);
    expect(
      table.children.map((row) => row.children.map((cell) => cell.header)),
    ).toEqual([
      [true, true, true],
      [undefined, undefined, undefined],
      [undefined, undefined, undefined],
    ]);
    expect(
      table.children.flatMap((row) =>
        row.children.map((cell) => cell.children),
      ),
    ).toEqual(Array.from({ length: 9 }, () => [{ text: "" }]));
  });

  it("appends an unaligned column to every row and returns its first cell path", () => {
    const editor = editorWithTable();

    const firstNewCellPath = appendTableColumn(editor, [0]);
    const table = firstTable(editor);

    expect(firstNewCellPath).toEqual([0, 0, 2]);
    expect(Node.get(editor, firstNewCellPath)).toBe(
      table.children[0].children[2],
    );
    expect(table.align).toEqual(["left", "right", null]);
    expect(table.children.map((row) => row.children.length)).toEqual([3, 3]);
    expect(
      table.children.map((row) => row.children.map((cell) => cell.align)),
    ).toEqual([
      ["left", "right", undefined],
      ["left", "right", undefined],
    ]);
    expect(
      table.children.map((row) => row.children.map((cell) => cell.header)),
    ).toEqual([
      [true, true, true],
      [undefined, undefined, undefined],
    ]);
    expect(table.children.map((row) => Node.string(row))).toEqual(["AB", "12"]);
    expect(table.children.map((row) => row.children[2].children)).toEqual([
      [{ text: "" }],
      [{ text: "" }],
    ]);
  });

  it("repairs ragged rows and stale alignment before appending a column", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [
      makeTable({
        align: ["left", "right", "center"],
        children: [
          makeTableRow({
            children: [
              makeTableCell({ header: true, children: [{ text: "A" }] }),
              makeTableCell({ header: true, children: [{ text: "B" }] }),
            ],
          }),
          makeTableRow({
            children: [makeTableCell({ children: [{ text: "1" }] })],
          }),
        ],
      }),
    ];

    expect(appendTableColumn(editor, [0])).toEqual([0, 0, 2]);
    const table = firstTable(editor);

    expect(table.align).toEqual(["left", "right", null]);
    expect(table.children.map((row) => row.children.length)).toEqual([3, 3]);
    expect(
      table.children.map((row) => row.children.map((cell) => cell.align)),
    ).toEqual([
      ["left", "right", undefined],
      ["left", "right", undefined],
    ]);
  });

  it("normalizes a wider body row into header cells and aligned columns before deletion", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [
      makeTable({
        align: ["left"],
        children: [
          makeTableRow({
            children: [
              makeTableCell({ header: true, children: [{ text: "A" }] }),
            ],
          }),
          makeTableRow({
            children: [
              makeTableCell({ children: [{ text: "1" }] }),
              makeTableCell({ children: [{ text: "2" }] }),
              makeTableCell({ children: [{ text: "3" }] }),
            ],
          }),
        ],
      }),
    ];

    Editor.normalize(editor, { force: true });
    const normalized = firstTable(editor);
    expect(normalized.align).toEqual(["left", null, null]);
    expect(normalized.children.map((row) => row.children.length)).toEqual([
      3, 3,
    ]);
    expect(normalized.children[0].children.map((cell) => cell.header)).toEqual([
      true,
      true,
      true,
    ]);

    const nearestCellPath = deleteTableColumn(editor, [0], 2);
    expect(nearestCellPath).toEqual([0, 0, 1]);
    expect(nearestCellPath && Node.has(editor, nearestCellPath)).toBe(true);
  });

  it("pads a shorter body row and truncates stale alignment before deletion", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [
      makeTable({
        align: ["left", "center", "right", "left"],
        children: [
          makeTableRow({
            children: [
              makeTableCell({ header: true, children: [{ text: "A" }] }),
              makeTableCell({ header: true, children: [{ text: "B" }] }),
              makeTableCell({ header: true, children: [{ text: "C" }] }),
            ],
          }),
          makeTableRow({
            children: [makeTableCell({ children: [{ text: "1" }] })],
          }),
        ],
      }),
    ];

    Editor.normalize(editor, { force: true });
    const normalized = firstTable(editor);
    expect(normalized.align).toEqual(["left", "center", "right"]);
    expect(normalized.children.map((row) => row.children.length)).toEqual([
      3, 3,
    ]);

    const nearestCellPath = deleteTableColumn(editor, [0], 1);
    expect(nearestCellPath).toEqual([0, 0, 1]);
    expect(nearestCellPath && Node.has(editor, nearestCellPath)).toBe(true);
  });

  it("appends a matching-width body row and returns its first cell path", () => {
    const editor = editorWithTable();

    const firstNewCellPath = appendTableRow(editor, [0]);
    const table = firstTable(editor);
    const newRow = table.children[2];

    expect(firstNewCellPath).toEqual([0, 2, 0]);
    expect(Node.get(editor, firstNewCellPath)).toBe(newRow.children[0]);
    expect(newRow.type).toBe("table-row");
    expect(newRow.children).toEqual([
      {
        type: "table-cell",
        align: "left",
        children: [{ text: "" }],
      },
      {
        type: "table-cell",
        align: "right",
        children: [{ text: "" }],
      },
    ]);
    expect(table.children.map((row) => row.children.length)).toEqual([2, 2, 2]);
    expect(table.children.slice(0, 2).map((row) => Node.string(row))).toEqual([
      "AB",
      "12",
    ]);
  });

  it("deletes a middle column from every row and returns the next surviving header cell", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [threeByThreeTable()];

    const nearestCellPath = deleteTableColumn(editor, [0], 1);
    const table = firstTable(editor);

    expect(nearestCellPath).toEqual([0, 0, 1]);
    expect(table.align).toEqual(["left", "right"]);
    expect(table.children.map((row) => Node.string(row))).toEqual([
      "AC",
      "13",
      "46",
    ]);
    expect(table.children.map((row) => row.children.length)).toEqual([2, 2, 2]);
  });

  it("returns the previous column when deleting the trailing column", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [threeByThreeTable()];

    expect(deleteTableColumn(editor, [0], 2)).toEqual([0, 0, 1]);
    expect(firstTable(editor).align).toEqual(["left", "center"]);
  });

  it("deletes a middle row, preserves alignment, and returns the next surviving row", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [threeByThreeTable()];

    const nearestCellPath = deleteTableRow(editor, [0], 1);
    const table = firstTable(editor);

    expect(nearestCellPath).toEqual([0, 1, 0]);
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.children.map((row) => Node.string(row))).toEqual([
      "ABC",
      "456",
    ]);
  });

  it("returns the previous row when deleting the trailing row", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [threeByThreeTable()];

    expect(deleteTableRow(editor, [0], 2)).toEqual([0, 1, 0]);
    expect(firstTable(editor).children.map((row) => Node.string(row))).toEqual([
      "ABC",
      "123",
    ]);
  });

  it("replaces a sole table with an empty paragraph when its final column is deleted", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [createTableGrid({ columns: 1, rows: 2 })];

    const nearestPath = deleteTableColumn(editor, [0], 0);
    expect(nearestPath).toEqual([0]);
    expect(nearestPath && Node.has(editor, nearestPath)).toBe(true);
    expect(editor.children).toEqual([
      { type: "paragraph", children: [{ text: "" }] },
    ]);
  });

  it("replaces a sole table with an empty paragraph when its final row is deleted", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [createTableGrid({ columns: 3, rows: 1 })];

    const nearestPath = deleteTableRow(editor, [0], 0);
    expect(nearestPath).toEqual([0]);
    expect(nearestPath && Node.has(editor, nearestPath)).toBe(true);
    expect(editor.children).toEqual([
      { type: "paragraph", children: [{ text: "" }] },
    ]);
  });
});

function editorWithGrid() {
  const editor = withTables(withSchema(createEditor()));
  editor.children = [threeByThreeTable()];
  Editor.normalize(editor, { force: true });
  return editor;
}

function grid(editor: Editor): string[][] {
  return firstTable(editor).children.map((row) =>
    row.children.map((cell) => Node.string(cell)),
  );
}

function headerFlags(editor: Editor): boolean[][] {
  return firstTable(editor).children.map((row) =>
    row.children.map((cell) => cell.header === true),
  );
}

describe("table transforms by index", () => {
  it("inserts an unaligned column before an existing one", () => {
    const editor = editorWithGrid();

    expect(insertTableColumn(editor, [0], 1)).toEqual([0, 0, 1]);

    expect(grid(editor)).toEqual([
      ["A", "", "B", "C"],
      ["1", "", "2", "3"],
      ["4", "", "5", "6"],
    ]);
    expect(firstTable(editor).align).toEqual(["left", null, "center", "right"]);
    expect(headerFlags(editor)[0]).toEqual([true, true, true, true]);
    expect(firstTable(editor).children[1].children[2].align).toBe("center");
  });

  it("appends when the column index is past the end", () => {
    const editor = editorWithGrid();
    expect(insertTableColumn(editor, [0], 3)).toEqual([0, 0, 3]);
    expect(grid(editor)[0]).toEqual(["A", "B", "C", ""]);
  });

  it("inserts an aligned body row and never displaces the header", () => {
    const editor = editorWithGrid();

    expect(insertTableRow(editor, [0], 0)).toEqual([0, 1, 0]);

    expect(grid(editor)).toEqual([
      ["A", "B", "C"],
      ["", "", ""],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
    expect(
      firstTable(editor).children[1].children.map((cell) => cell.align),
    ).toEqual(["left", "center", "right"]);
    expect(headerFlags(editor)[1]).toEqual([false, false, false]);
  });

  it("moves a column with its alignment", () => {
    const editor = editorWithGrid();

    expect(moveTableColumn(editor, [0], 0, 2)).toEqual([0, 0, 2]);

    expect(grid(editor)).toEqual([
      ["B", "C", "A"],
      ["2", "3", "1"],
      ["5", "6", "4"],
    ]);
    expect(firstTable(editor).align).toEqual(["center", "right", "left"]);
    expect(firstTable(editor).children[2].children[2].align).toBe("left");
  });

  it("refuses a column move that is out of range or a no-op", () => {
    const editor = editorWithGrid();
    expect(moveTableColumn(editor, [0], 1, 1)).toBeNull();
    expect(moveTableColumn(editor, [0], 0, 3)).toBeNull();
    expect(moveTableColumn(editor, [0], -1, 0)).toBeNull();
    expect(grid(editor)[0]).toEqual(["A", "B", "C"]);
  });

  it("moves a body row and keeps the header row pinned", () => {
    const editor = editorWithGrid();

    expect(moveTableRow(editor, [0], 2, 1)).toEqual([0, 1, 0]);
    expect(grid(editor)).toEqual([
      ["A", "B", "C"],
      ["4", "5", "6"],
      ["1", "2", "3"],
    ]);

    expect(moveTableRow(editor, [0], 0, 1)).toBeNull();
    expect(moveTableRow(editor, [0], 1, 0)).toBeNull();
    expect(grid(editor)[0]).toEqual(["A", "B", "C"]);
  });

  it("duplicates a column to its right, alignment included", () => {
    const editor = editorWithGrid();

    expect(duplicateTableColumn(editor, [0], 1)).toEqual([0, 0, 2]);

    expect(grid(editor)).toEqual([
      ["A", "B", "B", "C"],
      ["1", "2", "2", "3"],
      ["4", "5", "5", "6"],
    ]);
    expect(firstTable(editor).align).toEqual([
      "left",
      "center",
      "center",
      "right",
    ]);
  });

  it("duplicates a body row below itself", () => {
    const editor = editorWithGrid();
    expect(duplicateTableRow(editor, [0], 1)).toEqual([0, 2, 0]);
    expect(grid(editor)).toEqual([
      ["A", "B", "C"],
      ["1", "2", "3"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("duplicates the header row as a body row", () => {
    const editor = editorWithGrid();
    duplicateTableRow(editor, [0], 0);
    expect(grid(editor).slice(0, 2)).toEqual([
      ["A", "B", "C"],
      ["A", "B", "C"],
    ]);
    expect(headerFlags(editor).slice(0, 2)).toEqual([
      [true, true, true],
      [false, false, false],
    ]);
  });

  it("sets and clears a column's alignment on the table and its cells", () => {
    const editor = editorWithGrid();

    setTableColumnAlign(editor, [0], 0, "right");
    expect(firstTable(editor).align).toEqual(["right", "center", "right"]);
    expect(
      firstTable(editor).children.map((row) => row.children[0].align),
    ).toEqual(["right", "right", "right"]);

    setTableColumnAlign(editor, [0], 0, null);
    expect(firstTable(editor).align).toEqual([null, "center", "right"]);
    expect(
      firstTable(editor).children.map((row) => row.children[0].align),
    ).toEqual([undefined, undefined, undefined]);
  });

  it("sorts body rows numerically, keeps the header, and puts blanks last", () => {
    const editor = withTables(withSchema(createEditor()));
    const row = (...cells: string[]) =>
      makeTableRow({
        children: cells.map((text) => makeTableCell({ children: [{ text }] })),
      });
    editor.children = [
      makeTable({
        children: [
          makeTableRow({
            children: [
              makeTableCell({ header: true, children: [{ text: "n" }] }),
              makeTableCell({ header: true, children: [{ text: "id" }] }),
            ],
          }),
          row("10", "a"),
          row("", "b"),
          row("2", "c"),
          row("apple", "d"),
          row("2", "e"),
        ],
      }),
    ];
    Editor.normalize(editor, { force: true });
    const ids = () => grid(editor).map((cells) => cells[1]);

    expect(sortTableByColumn(editor, [0], 0, "ascending")).toBe(true);
    expect(ids()).toEqual(["id", "c", "e", "a", "d", "b"]);
    expect(sortTableByColumn(editor, [0], 0, "ascending")).toBe(false);

    expect(sortTableByColumn(editor, [0], 0, "descending")).toBe(true);
    expect(ids()).toEqual(["id", "d", "a", "c", "e", "b"]);
  });

  it("finds the drop boundary from item midpoints", () => {
    const extents = [
      [0, 100],
      [100, 300],
      [300, 400],
    ] as const;
    expect(dropBoundary(extents, -5)).toBe(0);
    expect(dropBoundary(extents, 49)).toBe(0);
    expect(dropBoundary(extents, 50)).toBe(1);
    expect(dropBoundary(extents, 199)).toBe(1);
    expect(dropBoundary(extents, 201)).toBe(2);
    expect(dropBoundary(extents, 999)).toBe(3);
  });

  it("maps a drop boundary to a move destination", () => {
    expect(moveTarget(1, 0)).toBe(0);
    expect(moveTarget(1, 1)).toBe(1);
    expect(moveTarget(1, 2)).toBe(1);
    expect(moveTarget(1, 3)).toBe(2);
  });
});
